import { equals, type DescMessage, type MessageShape } from "@bufbuild/protobuf";
import { createValidator } from "@bufbuild/protovalidate";
import { Code, ConnectError } from "@connectrpc/connect";
import {
  SessionRefSchema,
  type CallContext,
  type DocumentRef,
  type SessionRef,
} from "./generated/editorinterop/v1/editor_interop_pb.js";

export const REQUEST_BYTES = 33_554_432;
export const RESPONSE_BYTES = 65_536;
export const CHUNK_BYTES = 32_768;
export const CURSOR_IDLE_MS = 60_000;
const validator = createValidator();

export function checked<S extends DescMessage>(schema: S, value: MessageShape<S>): MessageShape<S> {
  const result = validator.validate(schema, value);
  if (result.kind !== "valid") throw new ConnectError(`Provider returned invalid ${schema.typeName}`, Code.Internal);
  return value;
}

export function required<T>(value: T | undefined, label: string): T {
  if (value === undefined) throw new ConnectError(`Missing ${label}`, Code.InvalidArgument);
  return value;
}

export function sameSession(left: SessionRef | undefined, right: SessionRef | undefined): boolean {
  if (!left || !right) return false;
  return equals(SessionRefSchema, left, right);
}

export function assertContext(actual: CallContext | undefined, expected: CallContext): void {
  if (!actual || !sameSession(actual.session, expected.session) || actual.generation !== expected.generation) {
    throw new ConnectError("The editor activation changed; reconnect explicitly", Code.FailedPrecondition);
  }
}

export function documentKey(ref: DocumentRef | undefined): string {
  const value = required(ref, "document identity");
  const session = required(value.session, "document session");
  return JSON.stringify([
    session.providerId,
    session.projectId,
    session.conversationId,
    value.ownerId,
    value.documentId,
  ]);
}

/** Serializes effects without leaving the queue poisoned by a rejected operation. */
export class SerialQueue {
  private tail: Promise<unknown> = Promise.resolve();
  run<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation);
    this.tail = result.catch(() => undefined);
    return result;
  }
}
