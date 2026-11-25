import assert from "node:assert/strict";
import { test } from "node:test";
import { create } from "@bufbuild/protobuf";
import {
  CallContextSchema,
  DocumentSnapshotSchema,
  FeedbackCommandSchema,
  FeedbackRecordSchema,
  FeedbackState,
  SaveCommandSchema,
} from "../src/generated/editorinterop/v1/editor_interop_pb.js";
import { FakeHostProvider, HOST_CONFORMANCE_CASES } from "../src/testing.js";

function fixture() {
  const context = create(CallContextSchema, {
    session: {
      providerId: "fake",
      projectId: "project",
      conversationId: "chat",
    },
    generation: "g1",
  });
  const document = create(DocumentSnapshotSchema, {
    ref: { session: context.session, ownerId: "owner", documentId: "document" },
    title: "Draft",
    revision: "r1",
    text: "Original",
    writable: true,
  });
  const command = create(SaveCommandSchema, {
    operationId: "operation",
    ref: document.ref,
    expectedRevision: "r1",
    text: "Candidate",
  });
  const feedback = create(FeedbackCommandSchema, {
    requestId: "request",
    ref: document.ref,
    baseRevision: "r1",
    bufferIdentity: "dirty-buffer",
    range: { startLine: 1, endLine: 1 },
    selectedText: "Exact unsaved 🦉",
    message: "Question about this",
  });
  const host = new FakeHostProvider(context, "owner");
  host.seedDocument(document);
  return { context, document, command, feedback, host };
}
const cases = {
  "save.rollback_before_commit": async () => {
    const f = fixture();
    f.host.beforeSave = () => Promise.reject(new Error("rollback"));
    await assert.rejects(f.host.save(f.context, f.command), /rollback/);
    assert.equal(f.host.documents()[0]?.text, "Original");
    assert.equal(f.host.saveEffects, 0);
    f.host.beforeSave = undefined;
    assert.equal(
      (await f.host.save(f.context, f.command)).result.case,
      "accepted",
    );
    assert.equal(f.host.saveEffects, 1);
  },
  "save.lost_reply_after_commit": async () => {
    const f = fixture();
    f.host.afterCommit = () => Promise.reject(new Error("lost"));
    await assert.rejects(f.host.save(f.context, f.command), /lost/);
    f.host.afterCommit = undefined;
    const recovered = await f.host.save(f.context, f.command);
    assert.equal(recovered.result.case, "accepted");
    assert.equal(f.host.saveEffects, 1);
  },
  "save.intervening_writer": async () => {
    const f = fixture();
    const first = await f.host.save(f.context, f.command);
    f.host.seedDocument(
      create(DocumentSnapshotSchema, {
        ...f.document,
        text: "Newer",
        revision: "r3",
      }),
    );
    assert.deepEqual(await f.host.save(f.context, f.command), first);
    assert.equal(f.host.documents()[0]?.text, "Newer");
  },
  "save.same_text_other_operation": async () => {
    const f = fixture();
    f.host.seedDocument(
      create(DocumentSnapshotSchema, {
        ...f.document,
        text: f.command.text,
        revision: "other-operation",
      }),
    );
    assert.equal(
      (await f.host.save(f.context, f.command)).result.case,
      "rejected",
    );
    assert.equal(f.host.saveEffects, 0);
  },
  "save.id_reused": async () => {
    const f = fixture();
    await f.host.save(f.context, f.command);
    assert.equal(
      (
        await f.host.save(
          f.context,
          create(SaveCommandSchema, { ...f.command, text: "Different" }),
        )
      ).result.case,
      "rejected",
    );
    assert.equal(f.host.saveEffects, 1);
  },
  "save.incomplete_evidence": async () => {
    const f = fixture();
    f.host.seedIncompleteSave(f.command);
    f.host.seedDocument(
      create(DocumentSnapshotSchema, { ...f.document, text: f.command.text }),
    );
    assert.equal(
      (await f.host.save(f.context, f.command)).result.case,
      "uncertain",
    );
    assert.equal(f.host.saveEffects, 0);
  },
  "save.stale_candidate": async () => {
    for (const first of ["editor", "agent"]) {
      const f = fixture();
      await f.host.save(
        f.context,
        create(SaveCommandSchema, { ...f.command, operationId: first }),
      );
      assert.equal(
        (
          await f.host.save(
            f.context,
            create(SaveCommandSchema, {
              ...f.command,
              operationId: `after-${first}`,
            }),
          )
        ).result.case,
        "rejected",
      );
      assert.equal(f.host.saveEffects, 1);
    }
  },
  "owner.changed_during_preflight": async () => {
    const f = fixture();
    f.host.beforeSave = async () => {
      await Promise.resolve();
      f.host.setActiveOwner("other");
    };
    assert.equal(
      (await f.host.save(f.context, f.command)).result.case,
      "rejected",
    );
    assert.equal(f.host.saveEffects, 0);
  },
  "feedback.exact_unsaved_selection": async () => {
    const f = fixture();
    const receipt = await f.host.submitFeedback(f.context, f.feedback);
    assert.deepEqual(receipt.request, f.feedback);
  },
  "feedback.duplicate_no_dispatch": async () => {
    const f = fixture();
    await f.host.submitFeedback(f.context, f.feedback);
    await f.host.submitFeedback(f.context, f.feedback);
    assert.equal(f.host.feedbackEffects, 1);
    await assert.rejects(
      f.host.submitFeedback(
        f.context,
        create(FeedbackCommandSchema, { ...f.feedback, message: "Different" }),
      ),
      /already belongs/,
    );
    assert.equal(f.host.feedbackEffects, 1);
  },
  "feedback.generation_terminal_preserved": () => {
    const f = fixture();
    const states = [
      FeedbackState.QUEUED,
      FeedbackState.DISPATCHING,
      FeedbackState.AWAITING,
      FeedbackState.PARKED,
      FeedbackState.ANSWERED,
      FeedbackState.FAILED,
      FeedbackState.UNCERTAIN,
    ];
    for (const state of states)
      f.host.setFeedback(
        create(FeedbackRecordSchema, {
          request: { ...f.feedback, requestId: String(state) },
          generation: "g1",
          state,
          reason: "Known evidence",
          summary: "Answer",
          responseId: "transcript",
        }),
      );
    f.host.activate("g2");
    assert.deepEqual(
      f.host.feedback().map((receipt) => receipt.state),
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
    assert.ok(
      f.host.feedback().every((receipt) => receipt.generation === "g1"),
    );
    return Promise.resolve();
  },
} satisfies Record<keyof typeof HOST_CONFORMANCE_CASES, () => Promise<void>>;
const descriptions = new Map<string, string>(
  Object.entries(HOST_CONFORMANCE_CASES),
);
for (const [id, run] of Object.entries(cases)) {
  const description = descriptions.get(id);
  assert.ok(description !== undefined);
  await test(`${id}: ${description}`, run);
}
