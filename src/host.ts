import type {
  CallContext,
  DocumentSnapshot,
  EditorRegistration,
  FeedbackCommand,
  FeedbackRecord,
  SaveCommand,
  SaveResult,
  SyncHeader,
} from "./generated/editorinterop/v1/editor_interop_pb.js";

/** Only for confirmed pre-effect failures; ambiguous outcomes require retained evidence. */
export class ProviderError extends Error {
  constructor(
    readonly code:
      | "invalid_argument"
      | "failed_precondition"
      | "already_exists",
    message: string,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

export type SnapshotItem =
  | { kind: "document"; value: DocumentSnapshot }
  | { kind: "feedback"; value: FeedbackRecord };

/** One immutable logical read view; close releases its storage snapshot. */
export interface SnapshotReader {
  readonly header: SyncHeader;
  next(): Promise<SnapshotItem | undefined>;
  close(): Promise<void>;
}

/** No Studio records, Pi contexts, SQL handles, or editor implementation types. */
export interface HostProvider {
  openSnapshot(call: CallContext): Promise<SnapshotReader>;
  /** Atomically commit candidate + operation witness, or return rejected/uncertain. */
  save(call: CallContext, command: SaveCommand): Promise<SaveResult>;
  /** Persist exact request before admission; preserve terminal outcomes across generations. */
  submitFeedback(
    call: CallContext,
    command: FeedbackCommand,
  ): Promise<FeedbackRecord>;
  onChanged(listener: () => void): () => void;
}

/** Retained in the SAME authoritative transaction as the document mutation. */
export interface SaveCommitWitness {
  readonly witnessId: string;
  readonly command: SaveCommand;
  readonly acceptedDocument: DocumentSnapshot;
}

export interface LaunchRequest {
  readonly launchId: string;
  readonly manifestPath: string;
  /** Directory containing the packaged bootstrap.lua and Lua modules. */
  readonly runtimePath: string;
  readonly workingDirectory: string;
  readonly title: string;
  readonly takeFocus: false;
  readonly explicit: boolean;
}
export type AttachmentState =
  | { state: "open"; attachmentId: string }
  | { state: "closed" }
  | { state: "uncertain"; reason: string };

/** Studio's implementation owns Zellij; the core treats attachment IDs as opaque. */
export interface EditorLauncher {
  ensure(request: LaunchRequest): Promise<AttachmentState>;
  inspect(attachmentId: string): Promise<AttachmentState>;
  verifyRegistration(
    request: LaunchRequest,
    registration: EditorRegistration,
  ): Promise<{ attachmentId: string; processIdentity: string }>;
  /** Release only owned observers; do not kill an editor or discard its buffers. */
  dispose(): Promise<void>;
}

export interface WorkspaceOptions {
  readonly context: CallContext;
  readonly provider: HostProvider;
  readonly launcher: EditorLauncher;
  /** Private task directory; core creates the socket, manifest and projections inside. */
  readonly directory: string;
  /** Directory containing the packaged bootstrap.lua and Lua modules. */
  readonly runtimePath: string;
  readonly workingDirectory: string;
  readonly title: string;
}

export interface EditorWorkspace {
  readonly manifestPath: string;
  /** Explicit reopening resets manual-close suppression after verified reconciliation. */
  open(): Promise<AttachmentState>;
  /** Coalesced refresh; also invoked through HostProvider.onChanged. */
  refresh(): Promise<void>;
  /** Stop endpoint/subscriptions; preserve editor text, durable receipts and recovery files. */
  dispose(): Promise<void>;
}
