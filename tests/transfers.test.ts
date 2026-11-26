import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { create, fromJsonString, toJsonString } from "@bufbuild/protobuf";
import { ChunkSource } from "../src/chunks.js";
import {
  CallContextSchema,
  DocumentRefSchema,
  DocumentSnapshotSchema,
  DocumentViewSchema,
  FeedbackCommandSchema,
  FeedbackRecordSchema,
  FeedbackState,
  SaveCommandSchema,
  SaveResultSchema,
  ValueChunkSchema,
  ValueKind,
} from "../src/generated/editorinterop/v1/editor_interop_pb.js";
import { Projections } from "../src/projections.js";
import { FakeHostProvider } from "../src/testing.js";
import { OperationTransfers, SnapshotTransfer } from "../src/transfers.js";

const context = create(CallContextSchema, {
  session: { providerId: "fake", projectId: "project", conversationId: "chat" },
  generation: "g1",
});
const document = create(DocumentSnapshotSchema, {
  ref: { session: context.session, ownerId: "owner", documentId: "doc" },
  title: "Draft",
  revision: "r1",
  writable: true,
  text: "Original",
});

await test("one valid host document larger than 32 MiB reconstructs without truncation through bounded pages", async () => {
  const directory = await mkdtemp(join(process.platform === "darwin" ? "/private/tmp" : tmpdir(), "ei-chunks-"));
  try {
    const text = '\u0000🦉"\\\n'.repeat(2_200_000);
    const view = create(DocumentViewSchema, {
      document: { ...document, text },
      projectionPath: join(directory, "document.md"),
    });
    const source = await ChunkSource.create(directory, ValueKind.DOCUMENT, DocumentViewSchema, view);
    const hash = createHash("sha256");
    const pieces: Uint8Array[] = [];
    let size = 0n;
    let count = 0;
    for (;;) {
      const chunk = await source.next();
      assert.equal(chunk.offset, size);
      assert.ok(chunk.data.length <= 32_768);
      assert.ok(Buffer.byteLength(toJsonString(ValueChunkSchema, chunk)) < 65_536);
      size += BigInt(chunk.data.length);
      hash.update(chunk.data);
      pieces.push(chunk.data);
      count++;
      if (chunk.valueComplete) {
        assert.equal(size, chunk.totalBytes);
        assert.deepEqual(hash.digest(), Buffer.from(chunk.sha256));
        break;
      }
    }
    assert.ok(size > 33_554_432n);
    assert.ok(count > 1_000);
    const decoded = fromJsonString(
      DocumentViewSchema,
      new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(pieces)),
    );
    assert.equal(decoded.document?.text, text);
    assert.deepEqual(await readdir(directory), []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

await test("result cursors replay the final page, expire without renewal on replay, and reserve before effects", async () => {
  const directory = await mkdtemp(join(process.platform === "darwin" ? "/private/tmp" : tmpdir(), "ei-results-"));
  let now = 0;
  const transfers = new OperationTransfers(directory, () => now);
  try {
    let effects = 0;
    const result = create(SaveResultSchema, {
      result: {
        case: "accepted",
        value: {
          operationId: "op",
          document: { ...document, text: "x".repeat(70_000) },
          commitWitnessId: "witness",
        },
      },
    });
    const produce = () => {
      effects++;
      return Promise.resolve(result);
    };
    let page = await transfers.start("first", ValueKind.SAVE_RESULT, SaveResultSchema, produce);
    assert.deepEqual(await transfers.start("first", ValueKind.SAVE_RESULT, SaveResultSchema, produce), page);
    let finalCursor = "";
    while (page.nextCursor !== "") {
      finalCursor = page.nextCursor;
      page = await transfers.next(finalCursor);
    }
    now = 59_000;
    assert.deepEqual(await transfers.next(finalCursor), page);
    for (const key of ["two", "three", "four", "five"])
      await transfers.start(key, ValueKind.SAVE_RESULT, SaveResultSchema, produce);
    await assert.rejects(transfers.start("six", ValueKind.SAVE_RESULT, SaveResultSchema, produce), /slots are full/);
    assert.equal(effects, 5);
    now = 60_001;
    await assert.rejects(transfers.next(finalCursor), /expired/);
    now = 119_001;
    await transfers.start("six", ValueKind.SAVE_RESULT, SaveResultSchema, produce);
    assert.equal(effects, 6);
  } finally {
    await transfers.close();
    await rm(directory, { recursive: true, force: true });
  }
});

await test("immutable snapshot pages finish with verified counts; superseded and expired views cannot complete", async () => {
  const directory = await mkdtemp(join(process.platform === "darwin" ? "/private/tmp" : tmpdir(), "ei-snapshot-"));
  const projectionDirectory = join(directory, "documents");
  await mkdir(projectionDirectory, { mode: 0o700 });
  const host = new FakeHostProvider(context, "owner");
  host.seedDocument(document);
  let now = 0;
  const transfer = new SnapshotTransfer(directory, host, context, new Projections(projectionDirectory), () => now);
  try {
    const first = await transfer.call("");
    const second = await transfer.call("");
    await assert.rejects(transfer.call(first.nextCursor), /expired/);
    host.setActiveOwner(undefined);
    let page = await transfer.call(second.nextCursor);
    assert.equal(page.part.case, "item");
    const final = await transfer.call(page.nextCursor);
    assert.equal(final.part.case, "complete");
    assert.equal(final.part.value.documentCount, 1n);
    page = await transfer.call("");
    now = 60_001;
    await assert.rejects(transfer.call(page.nextCursor), /expired/);
  } finally {
    await transfer.close();
    await rm(directory, { recursive: true, force: true });
  }
});

await test("fake host preserves terminal outcomes across generations and fences both competing save orderings", async () => {
  const host = new FakeHostProvider(context, "owner");
  host.seedDocument(document);
  for (const state of [
    FeedbackState.QUEUED,
    FeedbackState.DISPATCHING,
    FeedbackState.AWAITING,
    FeedbackState.PARKED,
    FeedbackState.ANSWERED,
    FeedbackState.FAILED,
    FeedbackState.UNCERTAIN,
  ]) {
    host.setFeedback(
      create(FeedbackRecordSchema, {
        request: create(FeedbackCommandSchema, {
          requestId: `request-${String(state)}`,
          ref: document.ref,
          baseRevision: "r1",
          bufferIdentity: "buffer",
          range: { startLine: 1, endLine: 1 },
          selectedText: "unsaved",
          message: "Question",
        }),
        generation: "g1",
        state,
        reason: "Known evidence",
        summary: "Answered",
        responseId: "real-response",
      }),
    );
  }
  host.activate("g2");
  assert.deepEqual(
    host.feedback().map((receipt) => receipt.state),
    [
      FeedbackState.UNCERTAIN,
      FeedbackState.UNCERTAIN,
      FeedbackState.UNCERTAIN,
      FeedbackState.UNCERTAIN,
      FeedbackState.ANSWERED,
      FeedbackState.FAILED,
      FeedbackState.UNCERTAIN,
    ],
  );
  assert.ok(host.feedback().every((receipt) => receipt.generation === "g1"));
  const call = create(CallContextSchema, { ...context, generation: "g2" });
  const candidate = create(SaveCommandSchema, {
    operationId: "editor",
    ref: document.ref,
    expectedRevision: "r1",
    text: "editor text",
  });
  host.seedDocument(
    create(DocumentSnapshotSchema, {
      ...document,
      text: "agent text",
      revision: "agent-r2",
    }),
  );
  assert.equal((await host.save(call, candidate)).result.case, "rejected");
  const accepted = await host.save(
    call,
    create(SaveCommandSchema, {
      ...candidate,
      operationId: "editor-2",
      expectedRevision: "agent-r2",
    }),
  );
  assert.equal(accepted.result.case, "accepted");
  assert.equal(
    (
      await host.save(
        call,
        create(SaveCommandSchema, {
          ...candidate,
          operationId: "agent-after",
          expectedRevision: "agent-r2",
          text: "old agent candidate",
        }),
      )
    ).result.case,
    "rejected",
  );
  assert.equal(host.saveEffects, 1);
});

await test("64 completed replay tombstones reserve capacity before effects and expire without losing durable host evidence", async () => {
  const directory = await mkdtemp(join(process.platform === "darwin" ? "/private/tmp" : tmpdir(), "ei-tombstones-"));
  let now = 0;
  let effects = 0;
  const transfers = new OperationTransfers(directory, () => now);
  const result = create(SaveResultSchema, {
    result: {
      case: "accepted",
      value: {
        operationId: "large",
        document: { ...document, text: "x".repeat(40_000) },
        commitWitnessId: "durable-witness",
      },
    },
  });
  const produce = () => {
    effects++;
    return Promise.resolve(result);
  };
  try {
    let lastCursor = "";
    for (let index = 0; index < 64; index++) {
      const first = await transfers.start(String(index), ValueKind.SAVE_RESULT, SaveResultSchema, produce);
      lastCursor = first.nextCursor;
      assert.notEqual(lastCursor, "");
      assert.equal((await transfers.next(lastCursor)).nextCursor, "");
    }
    await assert.rejects(
      transfers.start("overflow", ValueKind.SAVE_RESULT, SaveResultSchema, produce),
      /replay capacity/,
    );
    assert.equal(effects, 64);
    now = 59_999;
    assert.equal((await transfers.next(lastCursor)).value?.valueComplete, true);
    now = 60_001;
    await transfers.start("after-expiry", ValueKind.SAVE_RESULT, SaveResultSchema, produce);
    assert.equal(effects, 65);
    await assert.rejects(transfers.next(lastCursor), /expired/);
  } finally {
    await transfers.close();
    await rm(directory, { recursive: true, force: true });
  }
});

await test("projection identity is stable across activation and opaque IDs cannot choose a path", async () => {
  const directory = await mkdtemp(join(process.platform === "darwin" ? "/private/tmp" : tmpdir(), "ei-projections-"));
  try {
    const first = await new Projections(directory).view(document);
    const nextActivation = await new Projections(directory).view(
      create(DocumentSnapshotSchema, {
        ...document,
        text: "Updated after reconnect",
        revision: "r2",
      }),
    );
    assert.equal(first.projectionPath, nextActivation.projectionPath);
    const foreign = create(DocumentSnapshotSchema, {
      ...document,
      ref: create(DocumentRefSchema, {
        session: context.session,
        ownerId: "../escape",
        documentId: "/tmp/not-owned",
      }),
    });
    const assigned = await new Projections(directory).view(foreign);
    assert.ok(assigned.projectionPath.startsWith(`${directory}/`));
    assert.match(assigned.projectionPath.slice(directory.length + 1), /^[a-f0-9]{64}\.md$/);
    assert.notEqual(assigned.projectionPath, first.projectionPath);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

await test("duplicate operation after continuation preserves the retained provider result and original cursors", async () => {
  const directory = await mkdtemp(join(process.platform === "darwin" ? "/private/tmp" : tmpdir(), "ei-duplicate-"));
  const transfers = new OperationTransfers(directory);
  let invocations = 0;
  const result = create(SaveResultSchema, {
    result: {
      case: "accepted",
      value: {
        operationId: "retained",
        document: { ...document, text: "x".repeat(100_000) },
        commitWitnessId: "witness",
      },
    },
  });
  const produce = () => {
    invocations++;
    return Promise.resolve(result);
  };
  try {
    const first = await transfers.start("retained", ValueKind.SAVE_RESULT, SaveResultSchema, produce);
    const second = await transfers.next(first.nextCursor);
    assert.notEqual(second.nextCursor, "");
    const duplicate = await transfers.start("retained", ValueKind.SAVE_RESULT, SaveResultSchema, produce);
    assert.deepEqual(duplicate, first);
    assert.equal(invocations, 1);
    assert.deepEqual(await transfers.next(first.nextCursor), second);
    let page = second;
    let finalCursor = "";
    while (page.nextCursor !== "") {
      finalCursor = page.nextCursor;
      page = await transfers.next(finalCursor);
    }
    assert.deepEqual(await transfers.next(finalCursor), page);
    const recovered = await transfers.start("retained", ValueKind.SAVE_RESULT, SaveResultSchema, produce);
    assert.equal(recovered.value?.offset, 0n);
    assert.deepEqual(
      await transfers.next(finalCursor),
      page,
      "Reading provider evidence after completion cannot revoke terminal replay",
    );
  } finally {
    await transfers.close();
    await rm(directory, { recursive: true, force: true });
  }
});
