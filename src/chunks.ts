import { createHash, randomUUID } from "node:crypto";
import { open, unlink, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import {
  create,
  toJson,
  type DescMessage,
  type JsonValue,
  type MessageShape,
} from "@bufbuild/protobuf";
import {
  ValueChunkSchema,
  type ValueChunk,
  type ValueKind,
} from "./generated/editorinterop/v1/editor_interop_pb.js";
import { checked, CHUNK_BYTES } from "./model.js";

// Serialize one host record incrementally: history size never becomes a JSON aggregate.
function* jsonParts(value: JsonValue): Generator<string> {
  if (typeof value === "string") {
    yield '"';
    for (let at = 0; at < value.length; at += 4096)
      yield JSON.stringify(value.slice(at, at + 4096)).slice(1, -1);
    yield '"';
  } else if (Array.isArray(value)) {
    yield "[";
    for (let index = 0; index < value.length; index++) {
      if (index !== 0) yield ",";
      const item = value[index];
      if (item !== undefined) yield* jsonParts(item);
    }
    yield "]";
  } else if (value !== null && typeof value === "object") {
    yield "{";
    let first = true;
    for (const [key, item] of Object.entries(value)) {
      if (!first) yield ",";
      first = false;
      yield JSON.stringify(key);
      yield ":";
      yield* jsonParts(item);
    }
    yield "}";
  } else yield JSON.stringify(value);
}

/** A private per-value spool; only one bounded fragment is read for each response. */
export class ChunkSource {
  private offset = 0;
  private closed = false;
  private constructor(
    private readonly path: string,
    private readonly file: FileHandle,
    private readonly size: number,
    private readonly digest: Uint8Array,
    private readonly kind: ValueKind,
    private readonly id: string,
  ) {}
  static async create<S extends DescMessage>(
    directory: string,
    kind: ValueKind,
    schema: S,
    message: MessageShape<S>,
  ): Promise<ChunkSource> {
    checked(schema, message);
    const id = randomUUID();
    const path = join(directory, `${id}.part`);
    const file = await open(path, "wx+", 0o600);
    const hash = createHash("sha256");
    let size = 0;
    try {
      for (const part of jsonParts(toJson(schema, message))) {
        const buffer = Buffer.from(part);
        hash.update(buffer);
        let written = 0;
        while (written < buffer.length)
          written += (await file.write(buffer, written)).bytesWritten;
        size += buffer.length;
      }
      return new ChunkSource(path, file, size, hash.digest(), kind, id);
    } catch (error) {
      await file.close();
      await unlink(path);
      throw error;
    }
  }
  async next(): Promise<ValueChunk> {
    const value = await this.readAt(this.offset);
    this.offset += value.data.length;
    if (value.valueComplete) await this.close();
    return value;
  }
  /** Read a previous page without advancing or closing an unfinished immutable spool. */
  async readAt(offset: number): Promise<ValueChunk> {
    if (
      this.closed ||
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      offset >= this.size
    ) {
      throw new Error("Result spool offset is unavailable");
    }
    const bytes = Buffer.alloc(Math.min(CHUNK_BYTES, this.size - offset));
    let read = 0;
    while (read < bytes.length) {
      const result = await this.file.read(
        bytes,
        read,
        bytes.length - read,
        offset + read,
      );
      if (result.bytesRead === 0) throw new Error("Truncated result spool");
      read += result.bytesRead;
    }
    return create(ValueChunkSchema, {
      transferId: this.id,
      kind: this.kind,
      totalBytes: BigInt(this.size),
      sha256: this.digest,
      offset: BigInt(offset),
      data: bytes,
      valueComplete: offset + read === this.size,
    });
  }
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.file.close();
    await unlink(this.path);
  }
}
