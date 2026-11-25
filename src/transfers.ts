import {
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { mkdir, open, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  clone,
  create,
  type DescMessage,
  type MessageShape,
} from "@bufbuild/protobuf";
import { Code, ConnectError } from "@connectrpc/connect";
import {
  CallContextSchema,
  DocumentSnapshotSchema,
  DocumentViewSchema,
  FeedbackRecordSchema,
  ResultResponseSchema,
  SyncHeaderSchema,
  SyncResponseSchema,
  ValueKind,
  type CallContext,
  type ResultResponse,
  type SyncResponse,
} from "./generated/editorinterop/v1/editor_interop_pb.js";
import type { HostProvider, SnapshotReader } from "./host.js";
import {
  checked,
  CHUNK_BYTES,
  CURSOR_IDLE_MS,
  documentKey,
  required,
  sameSession,
} from "./model.js";
import type { Projections } from "./projections.js";
import { ChunkSource } from "./chunks.js";

interface CursorState<T> {
  next: string;
  touched: number;
  readonly replay: Map<string, T>;
}
function remember<T>(state: CursorState<T>, cursor: string, value: T): T {
  state.replay.set(cursor, value);
  if (state.replay.size > 2) {
    const oldest = state.replay.keys().next().value;
    if (oldest !== undefined) state.replay.delete(oldest);
  }
  return value;
}
function missing(): never {
  throw new ConnectError("Transfer expired; read fresh state", Code.NotFound);
}

/** Incremental immutable host snapshots; only the current value is spooled. */
export class SnapshotTransfer {
  private state:
    | (CursorState<SyncResponse> & {
        id: string;
        sequence: bigint;
        reader: SnapshotReader;
        directory: string;
        source?: ChunkSource;
        documents: bigint;
        feedback: bigint;
        complete: boolean;
      })
    | undefined;
  constructor(
    private readonly directory: string,
    private readonly provider: HostProvider,
    private readonly context: CallContext,
    private readonly projections: Projections,
    private readonly now: () => number = Date.now,
  ) {}
  async call(cursor: string): Promise<SyncResponse> {
    if (
      this.state !== undefined &&
      this.now() - this.state.touched >= CURSOR_IDLE_MS
    )
      await this.close();
    if (cursor === "") {
      await this.close();
      const reader = await this.provider.openSnapshot(
        clone(CallContextSchema, this.context),
      );
      try {
        checked(SyncHeaderSchema, reader.header);
        if (!sameSession(reader.header.session, this.context.session))
          throw new ConnectError("Foreign snapshot session", Code.Internal);
        const id = randomUUID();
        const directory = join(this.directory, id);
        await mkdir(directory, { mode: 0o700 });
        this.state = {
          id,
          directory,
          reader,
          sequence: 1n,
          documents: 0n,
          feedback: 0n,
          complete: false,
          next: randomUUID(),
          touched: this.now(),
          replay: new Map(),
        };
        return create(SyncResponseSchema, {
          snapshotId: id,
          sequence: 1n,
          nextCursor: this.state.next,
          part: { case: "header", value: reader.header },
        });
      } catch (error) {
        await reader.close();
        throw error;
      }
    }
    const state = this.state;
    if (state === undefined) return missing();
    const replay = state.replay.get(cursor);
    if (replay !== undefined) return replay;
    if (cursor !== state.next || state.complete) return missing();
    try {
      if (state.source === undefined) {
        const item = await state.reader.next();
        if (item === undefined) {
          state.complete = true;
          state.next = "";
          state.touched = this.now();
          await state.reader.close();
          await rm(state.directory, { recursive: true, force: true });
          return remember(
            state,
            cursor,
            create(SyncResponseSchema, {
              snapshotId: state.id,
              sequence: ++state.sequence,
              part: {
                case: "complete",
                value: {
                  documentCount: state.documents,
                  feedbackCount: state.feedback,
                },
              },
            }),
          );
        }
        let identity: string;
        if (item.kind === "document") {
          checked(DocumentSnapshotSchema, item.value);
          const ref = required(item.value.ref, "document ref");
          if (
            !sameSession(ref.session, this.context.session) ||
            ref.ownerId !== state.reader.header.activeOwnerId
          )
            throw new ConnectError("Foreign snapshot document", Code.Internal);
          identity = `document:${documentKey(ref)}`;
          state.source = await ChunkSource.create(
            state.directory,
            ValueKind.DOCUMENT,
            DocumentViewSchema,
            await this.projections.view(item.value),
          );
          state.documents++;
        } else {
          checked(FeedbackRecordSchema, item.value);
          const request = required(item.value.request, "feedback request");
          if (!sameSession(request.ref?.session, this.context.session))
            throw new ConnectError("Foreign snapshot receipt", Code.Internal);
          identity = `feedback:${request.requestId}`;
          state.source = await ChunkSource.create(
            state.directory,
            ValueKind.FEEDBACK,
            FeedbackRecordSchema,
            item.value,
          );
          state.feedback++;
        }
        // Duplicate detection lives on disk so a long receipt history does not grow a memory set.
        const marker = join(
          state.directory,
          `${createHash("sha256").update(identity).digest("hex")}.seen`,
        );
        const file = await open(marker, "wx", 0o600);
        await file.close();
      }
      const value = await state.source.next();
      if (value.valueComplete) delete state.source;
      state.next = randomUUID();
      state.touched = this.now();
      return remember(
        state,
        cursor,
        create(SyncResponseSchema, {
          snapshotId: state.id,
          sequence: ++state.sequence,
          nextCursor: state.next,
          part: { case: "item", value },
        }),
      );
    } catch (error) {
      await this.close();
      throw error;
    }
  }
  async sweep(): Promise<void> {
    if (
      this.state !== undefined &&
      this.now() - this.state.touched >= CURSOR_IDLE_MS
    )
      await this.close();
  }
  async close(): Promise<void> {
    const state = this.state;
    this.state = undefined;
    if (state === undefined) return;
    await state.source?.close();
    if (!state.complete) await state.reader.close();
    await rm(state.directory, { recursive: true, force: true });
  }
}

interface ResultTransfer extends CursorState<ResultResponse> {
  source?: ChunkSource;
  first?: ResultResponse;
  readonly cursorIdentity: string;
  readonly cursorSecret: Uint8Array;
  position: number;
}

function operationCursor(state: ResultTransfer, offset: number): string {
  const payload = `${state.cursorIdentity}:${String(offset)}`;
  const signature = createHmac("sha256", state.cursorSecret)
    .update(payload)
    .digest("hex");
  return `${payload}:${signature}`;
}
function operationOffset(
  state: ResultTransfer,
  cursor: string,
): number | undefined {
  const [identity, encodedOffset] = cursor.split(":");
  if (identity !== state.cursorIdentity || encodedOffset === undefined)
    return undefined;
  const offset = Number(encodedOffset);
  if (
    !Number.isSafeInteger(offset) ||
    offset < CHUNK_BYTES ||
    offset > state.position ||
    offset % CHUNK_BYTES !== 0
  )
    return undefined;
  const actual = Buffer.from(cursor);
  const expected = Buffer.from(operationCursor(state, offset));
  return actual.length === expected.length && timingSafeEqual(actual, expected)
    ? offset
    : undefined;
}

/** Serialized caller: four unfinished values plus 64 reserved/completed replay slots. */
export class OperationTransfers {
  private readonly entries = new Map<string, ResultTransfer>();
  private readonly completed = new Map<string, ResultTransfer>();
  constructor(
    private readonly directory: string,
    private readonly now: () => number = Date.now,
  ) {}
  async start<S extends DescMessage>(
    key: string,
    kind: ValueKind,
    schema: S,
    produce: () => Promise<MessageShape<S>>,
  ): Promise<ResultResponse> {
    await this.sweep();
    const previous = this.entries.get(key);
    // An exact repeat is a read of the retained result, including after progress.
    // It cannot revoke another in-flight continuation or invoke the provider again.
    if (previous?.first !== undefined) return previous.first;
    if (this.entries.size >= 4)
      throw new ConnectError(
        "Operation result slots are full; retain the candidate",
        Code.ResourceExhausted,
      );
    if (this.entries.size + this.completed.size >= 64)
      throw new ConnectError(
        "Operation replay capacity is full; retain the candidate",
        Code.ResourceExhausted,
      );
    const state: ResultTransfer = {
      next: "",
      replay: new Map(),
      touched: this.now(),
      cursorIdentity: randomUUID(),
      cursorSecret: randomBytes(32),
      position: 0,
    };
    this.entries.set(key, state);
    try {
      state.source = await ChunkSource.create(
        this.directory,
        kind,
        schema,
        await produce(),
      );
      const value = await state.source.next();
      if (value.valueComplete) delete state.source;
      state.position = value.data.length;
      state.next = value.valueComplete
        ? ""
        : operationCursor(state, state.position);
      state.touched = this.now();
      state.first = create(ResultResponseSchema, {
        value,
        nextCursor: state.next,
      });
      // No Result cursor exists for a single-page reply. Durable retries read the host witness.
      if (value.valueComplete) this.entries.delete(key);
      return state.first;
    } catch (error) {
      this.entries.delete(key);
      await state.source?.close();
      throw error;
    }
  }
  async next(cursor: string): Promise<ResultResponse> {
    await this.sweep();
    for (const state of this.completed.values()) {
      const replay = state.replay.get(cursor);
      if (replay !== undefined) return replay;
    }
    for (const [key, state] of this.entries) {
      const replay = state.replay.get(cursor);
      if (replay !== undefined) return replay;
      const offset = operationOffset(state, cursor);
      if (offset === undefined || state.source === undefined) continue;
      const value = await state.source.readAt(offset);
      const nextOffset = offset + value.data.length;
      const response = create(ResultResponseSchema, {
        value,
        nextCursor: value.valueComplete
          ? ""
          : operationCursor(state, nextOffset),
      });
      // A discarded client stage can be rebuilt from disk, without replacing the
      // current cursor/cache or extending the lease for historical page replay.
      if (offset < state.position) return response;
      state.position = nextOffset;
      state.next = response.nextCursor;
      state.touched = this.now();
      remember(state, cursor, response);
      if (value.valueComplete) {
        await state.source.close();
        delete state.source;
        this.entries.delete(key);
        delete state.first;
        this.completed.set(randomUUID(), state);
      }
      return response;
    }
    return missing();
  }
  async sweep(): Promise<void> {
    for (const collection of [this.entries, this.completed]) {
      for (const [key, state] of collection) {
        if (this.now() - state.touched < CURSOR_IDLE_MS) continue;
        await state.source?.close();
        collection.delete(key);
      }
    }
  }
  async close(): Promise<void> {
    for (const state of this.entries.values()) await state.source?.close();
    this.entries.clear();
    this.completed.clear();
  }
}
