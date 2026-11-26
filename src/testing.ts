import { randomUUID } from "node:crypto";
import { clone, create, equals } from "@bufbuild/protobuf";
import {
  CallContextSchema,
  DocumentSnapshotSchema,
  FeedbackCommandSchema,
  FeedbackRecordSchema,
  FeedbackState,
  RejectionCode,
  SaveCommandSchema,
  SaveResultSchema,
  SyncHeaderSchema,
  type CallContext,
  type DocumentSnapshot,
  type FeedbackCommand,
  type FeedbackRecord,
  type SaveCommand,
  type SaveResult,
} from "./generated/editorinterop/v1/editor_interop_pb.js";
import {
  ProviderError,
  type AttachmentState,
  type EditorLauncher,
  type HostProvider,
  type LaunchRequest,
  type SnapshotItem,
  type SnapshotReader,
} from "./host.js";
import { assertContext, documentKey, sameSession } from "./model.js";

/** Stable provider case IDs shared by independent and real-host evidence. */
export const HOST_CONFORMANCE_CASES = {
  "save.rollback_before_commit": "Neither document mutation nor accepted witness survives a failed transaction.",
  "save.lost_reply_after_commit": "An exact repeat recovers the original atomic witness after a lost reply.",
  "save.intervening_writer": "Recovering an earlier witness never overwrites a later writer.",
  "save.same_text_other_operation": "Identical current text does not prove this operation committed.",
  "save.id_reused": "Reusing an operation ID with different content has no second effect.",
  "save.incomplete_evidence": "Historical incomplete evidence stays uncertain without automatic replay.",
  "save.stale_candidate": "Whichever writer commits first fences the other writer's stale candidate.",
  "owner.changed_during_preflight": "Ownership is checked after awaited preflight immediately before effects.",
  "feedback.exact_unsaved_selection": "The receipt retains the captured unsaved excerpt and instruction exactly.",
  "feedback.duplicate_no_dispatch": "Repeating a feedback ID never causes another dispatch.",
  "feedback.generation_terminal_preserved":
    "Answered and confirmed-failed receipts remain terminal; unfinished receipts become uncertain.",
} as const;

/** In-memory host for standalone conformance; its atomic block has no external crash durability. */
export class FakeHostProvider implements HostProvider {
  private context: CallContext;
  private activeOwner: string | undefined;
  private readonly documentsById = new Map<string, DocumentSnapshot>();
  private readonly receiptsById = new Map<string, FeedbackRecord>();
  private readonly witnesses = new Map<string, { command: SaveCommand; result: SaveResult }>();
  private readonly incomplete = new Map<string, SaveCommand>();
  private readonly listeners = new Set<() => void>();
  /** Runs before authoritative guards, allowing tests to change ownership or delay acceptance. */
  beforeSave: ((command: SaveCommand) => Promise<void>) | undefined;
  beforeFeedback: ((command: FeedbackCommand) => Promise<void>) | undefined;
  /** May simulate a lost reply after both mutation and witness exist. */
  afterCommit: ((command: SaveCommand) => Promise<void>) | undefined;
  saveEffects = 0;
  feedbackEffects = 0;
  constructor(context: CallContext, activeOwnerId?: string) {
    this.context = clone(CallContextSchema, context);
    this.activeOwner = activeOwnerId;
  }
  seedDocument(document: DocumentSnapshot): void {
    this.documentsById.set(documentKey(document.ref), clone(DocumentSnapshotSchema, document));
    this.changed();
  }
  /** Models imported historical journal evidence without an authoritative commit witness. */
  seedIncompleteSave(command: SaveCommand): void {
    this.incomplete.set(command.operationId, clone(SaveCommandSchema, command));
  }
  removeDocument(document: DocumentSnapshot): void {
    this.documentsById.delete(documentKey(document.ref));
    this.changed();
  }
  setActiveOwner(ownerId: string | undefined): void {
    this.activeOwner = ownerId;
    this.changed();
  }
  setFeedback(record: FeedbackRecord): void {
    if (!record.request) throw new Error("Feedback record requires request identity");
    this.receiptsById.set(record.request.requestId, clone(FeedbackRecordSchema, record));
    this.changed();
  }
  activate(generation: string): void {
    this.context.generation = generation;
    for (const receipt of this.receiptsById.values()) {
      if (
        [FeedbackState.QUEUED, FeedbackState.DISPATCHING, FeedbackState.AWAITING, FeedbackState.PARKED].includes(
          receipt.state,
        )
      ) {
        receipt.state = FeedbackState.UNCERTAIN;
        receipt.reason = "Activation changed before a confirmed terminal outcome";
      }
    }
    this.changed();
  }
  documents(): DocumentSnapshot[] {
    return [...this.documentsById.values()].map((value) => clone(DocumentSnapshotSchema, value));
  }
  feedback(): FeedbackRecord[] {
    return [...this.receiptsById.values()].map((value) => clone(FeedbackRecordSchema, value));
  }
  onChanged(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  private changed(): void {
    for (const listener of this.listeners) listener();
  }
  openSnapshot(call: CallContext): Promise<SnapshotReader> {
    assertContext(call, this.context);
    const items: SnapshotItem[] = [
      ...this.documents()
        .filter((document) => document.ref?.ownerId === this.activeOwner)
        .map((value): SnapshotItem => ({ kind: "document", value })),
      ...this.feedback().map((value): SnapshotItem => ({ kind: "feedback", value })),
    ];
    const header = create(SyncHeaderSchema, {
      session: this.context.session,
      activeOwnerId: this.activeOwner,
    });
    let index = 0;
    let closed = false;
    return Promise.resolve({
      header,
      next: () => Promise.resolve(closed ? undefined : items[index++]),
      close: () => {
        closed = true;
        return Promise.resolve();
      },
    });
  }
  async save(call: CallContext, command: SaveCommand): Promise<SaveResult> {
    await this.beforeSave?.(command);
    assertContext(call, this.context);
    const previous = this.witnesses.get(command.operationId);
    if (previous) {
      return equals(SaveCommandSchema, previous.command, command)
        ? clone(SaveResultSchema, previous.result)
        : this.reject(command, RejectionCode.OPERATION_ID_REUSED, "Operation ID already belongs to different content");
    }
    const incomplete = this.incomplete.get(command.operationId);
    if (incomplete) {
      if (!equals(SaveCommandSchema, incomplete, command))
        return this.reject(
          command,
          RejectionCode.OPERATION_ID_REUSED,
          "Operation ID already belongs to historical evidence",
        );
      return create(SaveResultSchema, {
        result: {
          case: "uncertain",
          value: {
            operationId: command.operationId,
            reason: "Historical operation has no authoritative witness",
          },
        },
      });
    }
    const current = this.documentsById.get(documentKey(command.ref));
    if (!sameSession(command.ref?.session, this.context.session) || command.ref?.ownerId !== this.activeOwner)
      return this.reject(command, RejectionCode.WRONG_OWNER, "Document owner is no longer active", current);
    if (!current || current.revision !== command.expectedRevision)
      return this.reject(command, RejectionCode.CONFLICT, "Document revision changed", current);
    if (!current.writable)
      return this.reject(
        command,
        RejectionCode.PROTECTED,
        current.reason !== "" ? current.reason : "Document is protected",
        current,
      );
    const accepted = create(DocumentSnapshotSchema, {
      ...current,
      text: command.text,
      revision: randomUUID(),
    });
    const result = create(SaveResultSchema, {
      result: {
        case: "accepted",
        value: {
          operationId: command.operationId,
          document: accepted,
          commitWitnessId: randomUUID(),
        },
      },
    });
    // No await between these updates: this fake models the host's required atomic commit boundary.
    this.documentsById.set(documentKey(command.ref), accepted);
    this.witnesses.set(command.operationId, {
      command: clone(SaveCommandSchema, command),
      result: clone(SaveResultSchema, result),
    });
    this.saveEffects++;
    this.changed();
    await this.afterCommit?.(command);
    return result;
  }
  async submitFeedback(call: CallContext, command: FeedbackCommand): Promise<FeedbackRecord> {
    await this.beforeFeedback?.(command);
    assertContext(call, this.context);
    const previous = this.receiptsById.get(command.requestId);
    if (previous) {
      if (!previous.request || !equals(FeedbackCommandSchema, previous.request, command))
        throw new ProviderError("already_exists", "Feedback ID already belongs to different content");
      return clone(FeedbackRecordSchema, previous);
    }
    if (!sameSession(command.ref?.session, this.context.session) || command.ref?.ownerId !== this.activeOwner)
      throw new ProviderError("failed_precondition", "Feedback owner is no longer active");
    const record = create(FeedbackRecordSchema, {
      request: clone(FeedbackCommandSchema, command),
      generation: call.generation,
      state: FeedbackState.QUEUED,
    });
    this.receiptsById.set(command.requestId, record);
    this.feedbackEffects++;
    this.changed();
    return clone(FeedbackRecordSchema, record);
  }
  private reject(command: SaveCommand, code: RejectionCode, reason: string, current?: DocumentSnapshot): SaveResult {
    return create(SaveResultSchema, {
      result: {
        case: "rejected",
        value: { operationId: command.operationId, code, reason, current },
      },
    });
  }
}

/** Deterministic launcher for API tests; native acceptance supplies real process verification. */
export class FakeLauncher implements EditorLauncher {
  readonly requests: LaunchRequest[] = [];
  state: AttachmentState = { state: "closed" };
  ensure(request: LaunchRequest): Promise<AttachmentState> {
    this.requests.push(request);
    this.state = { state: "open", attachmentId: request.launchId };
    return Promise.resolve(this.state);
  }
  inspect(): Promise<AttachmentState> {
    return Promise.resolve(this.state);
  }
  verifyRegistration(request: LaunchRequest): Promise<{ attachmentId: string; processIdentity: string }> {
    return Promise.resolve({
      attachmentId: request.launchId,
      processIdentity: `fake:${request.launchId}`,
    });
  }
  dispose(): Promise<void> {
    return Promise.resolve();
  }
}
