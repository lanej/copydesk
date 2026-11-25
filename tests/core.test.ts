import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  create,
  fromJsonString,
  type DescMessage,
  type MessageShape,
} from "@bufbuild/protobuf";
import { createClient } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-node";
import { createWorkspace } from "../src/index.js";
import {
  CallContextSchema,
  ConnectionManifestSchema,
  DocumentSnapshotSchema,
  DocumentViewSchema,
  EditorInteropService,
  FeedbackRecordSchema,
  FeedbackState,
  SaveResultSchema,
  type ValueChunk,
} from "../src/generated/editorinterop/v1/editor_interop_pb.js";
import { FakeHostProvider, FakeLauncher } from "../src/testing.js";

async function fixture() {
  const directory = await mkdtemp(
    join(process.platform === "darwin" ? "/private/tmp" : tmpdir(), "ei-"),
  );
  const context = create(CallContextSchema, {
    session: {
      providerId: "fake",
      projectId: "project",
      conversationId: "conversation",
    },
    generation: "generation-1",
  });
  const document = create(DocumentSnapshotSchema, {
    ref: { session: context.session, ownerId: "owner-1", documentId: "spec" },
    title: "Specification",
    text: "# Draft\nOriginal\n",
    revision: "revision-1",
    writable: true,
  });
  const host = new FakeHostProvider(context, "owner-1");
  host.seedDocument(document);
  const launcher = new FakeLauncher();
  const workspace = await createWorkspace({
    context,
    provider: host,
    launcher,
    directory,
    runtimePath: join(process.cwd(), "resources/nvim"),
    workingDirectory: process.cwd(),
    title: "Documents",
  });
  const manifest = fromJsonString(
    ConnectionManifestSchema,
    await readFile(workspace.manifestPath, "utf8"),
  );
  const client = createClient(
    EditorInteropService,
    createConnectTransport({
      baseUrl: "http://localhost",
      httpVersion: "1.1",
      useBinaryFormat: false,
      nodeOptions: { socketPath: manifest.socketPath, agent: false },
      defaultTimeoutMs: 2000,
      acceptCompression: [],
    }),
  );
  const options = {
    headers: { authorization: `Bearer ${manifest.bearerToken}` },
  };
  const editor = {
    editorInstanceId: "editor-1",
    processId: process.pid,
    rpcAddress: join(directory, "nvim"),
    launchId: manifest.launchId,
  };
  await client.register({ context, version: { major: 1 }, editor }, options);
  async function result<S extends DescMessage>(
    initial: { value?: ValueChunk | undefined; nextCursor: string },
    schema: S,
  ): Promise<MessageShape<S>> {
    const pieces: Uint8Array[] = [];
    let page = initial;
    for (;;) {
      assert.ok(page.value !== undefined);
      pieces.push(page.value.data);
      if (page.nextCursor === "") break;
      page = await client.result({ context, cursor: page.nextCursor }, options);
    }
    return fromJsonString(schema, Buffer.concat(pieces).toString("utf8"));
  }
  return {
    directory,
    context,
    document,
    host,
    launcher,
    workspace,
    manifest,
    client,
    options,
    editor,
    result,
    close: async () => {
      await workspace.dispose();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

await test("real Connect Unix loop preserves projections, atomic save result and exact unsaved feedback", async () => {
  const f = await fixture();
  try {
    const header = await f.client.sync({ context: f.context }, f.options);
    assert.equal(header.part.case, "header");
    const item = await f.client.sync(
      { context: f.context, cursor: header.nextCursor },
      f.options,
    );
    assert.equal(item.part.case, "item");
    const view = fromJsonString(
      DocumentViewSchema,
      Buffer.from(item.part.value.data).toString("utf8"),
    );
    assert.equal(
      await readFile(view.projectionPath, "utf8"),
      "# Draft\nOriginal\n",
    );
    const finalCursor = item.nextCursor;
    const complete = await f.client.sync(
      { context: f.context, cursor: finalCursor },
      f.options,
    );
    assert.deepEqual(
      await f.client.sync(
        { context: f.context, cursor: finalCursor },
        f.options,
      ),
      complete,
    );
    assert.equal(complete.part.case, "complete");
    const command = {
      operationId: "save-1",
      ref: f.document.ref,
      expectedRevision: "revision-1",
      text: "# Draft\nEdited 🦉\n",
    };
    const accepted = await f.result(
      await f.client.save({ context: f.context, command }, f.options),
      SaveResultSchema,
    );
    assert.equal(accepted.result.case, "accepted");
    assert.equal(await readFile(view.projectionPath, "utf8"), command.text);
    await f.client.save({ context: f.context, command }, f.options);
    assert.equal(f.host.saveEffects, 1);
    const feedbackCommand = {
      requestId: "feedback-1",
      ref: f.document.ref,
      baseRevision: "revision-1",
      bufferIdentity: "unsaved-2",
      range: { startLine: 2, endLine: 2 },
      selectedText: "Locally changed exact excerpt 🦉",
      message: "Do we want this?",
    };
    const feedback = await f.result(
      await f.client.feedback(
        { context: f.context, command: feedbackCommand },
        f.options,
      ),
      FeedbackRecordSchema,
    );
    assert.equal(feedback.request?.selectedText, feedbackCommand.selectedText);
    assert.equal(feedback.state, FeedbackState.QUEUED);
    await f.client.feedback(
      { context: f.context, command: feedbackCommand },
      f.options,
    );
    assert.equal(f.host.feedbackEffects, 1);
    assert.equal(f.launcher.requests.length, 1);
    assert.equal(f.launcher.requests[0]?.takeFocus, false);
  } finally {
    await f.close();
  }
});

await test("wire rejects unregistered, forged, stale and schema-invalid requests before host effects", async () => {
  const f = await fixture();
  try {
    const command = {
      operationId: "guarded",
      ref: f.document.ref,
      expectedRevision: "revision-1",
      text: "changed",
    };
    await assert.rejects(
      f.client.save(
        { context: f.context, command },
        { headers: { authorization: "Bearer wrong" } },
      ),
      /Invalid editor credential/,
    );
    await assert.rejects(
      f.client.save(
        { context: { ...f.context, generation: "old" }, command },
        f.options,
      ),
      /activation changed/,
    );
    await assert.rejects(
      f.client.register(
        { context: f.context, version: { major: 2 }, editor: f.editor },
        f.options,
      ),
      /compatible/,
    );
    await assert.rejects(
      f.client.register(
        {
          context: f.context,
          version: { major: 1 },
          editor: { ...f.editor, editorInstanceId: "other" },
        },
        f.options,
      ),
      /issued launch/,
    );
    const raw = await new Promise<{ status: number; body: string }>(
      (resolve, reject) => {
        const body = JSON.stringify({
          context: f.context,
          command: { ...command, unknownMeaning: true },
        });
        const req = request(
          {
            socketPath: f.manifest.socketPath,
            path: "/editorinterop.v1.EditorInteropService/Save",
            method: "POST",
            agent: false,
            headers: {
              ...f.options.headers,
              "content-type": "application/json",
              "connect-protocol-version": "1",
              "content-length": Buffer.byteLength(body),
            },
          },
          (res) => {
            let response = "";
            res.setEncoding("utf8");
            res.on("data", (part: string) => {
              response += part;
            });
            res.once("error", reject);
            res.once("end", () => {
              resolve({ status: res.statusCode ?? 0, body: response });
            });
          },
        );
        req.once("error", reject);
        req.end(body);
      },
    );
    assert.equal(raw.status, 400);
    assert.match(raw.body, /unknown/);
    assert.equal(f.host.saveEffects, 0);
    f.host.beforeSave = () => {
      f.host.setActiveOwner("owner-2");
      return Promise.resolve();
    };
    const refused = await f.result(
      await f.client.save({ context: f.context, command }, f.options),
      SaveResultSchema,
    );
    assert.equal(refused.result.case, "rejected");
    assert.equal(f.host.saveEffects, 0);
  } finally {
    await f.close();
  }
});

await test("lost committed reply resolves the original witness without rolling back an intervening writer", async () => {
  const f = await fixture();
  try {
    const command = {
      operationId: "lost",
      ref: f.document.ref,
      expectedRevision: "revision-1",
      text: "first committed",
    };
    f.host.afterCommit = () => Promise.reject(new Error("lost response"));
    await assert.rejects(
      f.client.save({ context: f.context, command }, f.options),
      /internal/,
    );
    const committed = f.host.documents()[0];
    assert.ok(committed !== undefined);
    f.host.seedDocument(
      create(DocumentSnapshotSchema, {
        ...committed,
        text: "newer writer",
        revision: "newer-revision",
      }),
    );
    f.host.afterCommit = undefined;
    const recovered = await f.result(
      await f.client.save({ context: f.context, command }, f.options),
      SaveResultSchema,
    );
    assert.equal(recovered.result.case, "accepted");
    assert.equal(recovered.result.value.document?.revision, committed.revision);
    assert.equal(f.host.documents()[0]?.text, "newer writer");
    assert.equal(f.host.saveEffects, 1);
    const header = await f.client.sync({ context: f.context }, f.options);
    const item = await f.client.sync(
      { context: f.context, cursor: header.nextCursor },
      f.options,
    );
    if (item.part.case !== "item") throw new Error("Expected document");
    const view = fromJsonString(
      DocumentViewSchema,
      Buffer.from(item.part.value.data).toString("utf8"),
    );
    assert.equal(await readFile(view.projectionPath, "utf8"), "newer writer");
  } finally {
    await f.close();
  }
});

await test("manual close suppresses automatic reopening and explicit reopen rotates credentials", async () => {
  const f = await fixture();
  try {
    f.launcher.state = { state: "closed" };
    await f.workspace.refresh();
    await f.workspace.refresh();
    assert.equal(f.launcher.requests.length, 1);
    const reopened = await f.workspace.open();
    assert.equal(reopened.state, "open");
    assert.equal(f.launcher.requests.length, 2);
    const current = fromJsonString(
      ConnectionManifestSchema,
      await readFile(f.workspace.manifestPath, "utf8"),
    );
    assert.notEqual(current.bearerToken, f.manifest.bearerToken);
    await assert.rejects(
      f.client.sync({ context: f.context }, f.options),
      /Invalid editor credential/,
    );
    await assert.rejects(
      f.client.sync(
        { context: f.context },
        { headers: { authorization: `Bearer ${current.bearerToken}` } },
      ),
      /Register/,
    );
  } finally {
    await f.close();
  }
});

await test("ordinary completed saves release transient capacity immediately", async () => {
  const f = await fixture();
  try {
    let revision = f.document.revision;
    for (let index = 0; index < 8; index++) {
      const result = await f.result(
        await f.client.save(
          {
            context: f.context,
            command: {
              operationId: `ordinary-${String(index)}`,
              ref: f.document.ref,
              expectedRevision: revision,
              text: `Edit ${String(index)}`,
            },
          },
          f.options,
        ),
        SaveResultSchema,
      );
      assert.equal(result.result.case, "accepted");
      const accepted = result.result.value.document;
      assert.ok(accepted !== undefined);
      revision = accepted.revision;
    }
    assert.equal(f.host.saveEffects, 8);
    assert.equal(f.host.documents()[0]?.text, "Edit 7");
  } finally {
    await f.close();
  }
});

for (const stage of ["inspect", "uncertain reconciliation"]) {
  await test(`disposal during deferred ${stage} prevents subsequent manifest and launch effects`, async () => {
    const f = await fixture();
    const started = Promise.withResolvers<undefined>();
    const release =
      Promise.withResolvers<import("../src/host.js").AttachmentState>();
    let reconciliations = 0;
    try {
      const before = await readFile(f.workspace.manifestPath, "utf8");
      if (stage === "inspect") {
        f.launcher.inspect = () => {
          started.resolve(undefined);
          return release.promise;
        };
      } else {
        f.launcher.inspect = () =>
          Promise.resolve({ state: "uncertain", reason: "Probe pending" });
        f.launcher.ensure = () => {
          reconciliations++;
          started.resolve(undefined);
          return release.promise;
        };
      }
      const opening = f.workspace.open();
      await started.promise;
      const rejected = assert.rejects(opening, /Workspace is disposed/);
      const disposal = f.workspace.dispose();
      release.resolve({ state: "closed" });
      await rejected;
      await disposal;
      assert.equal(await readFile(f.workspace.manifestPath, "utf8"), before);
      assert.equal(
        f.launcher.requests.length,
        1,
        "No additional pane launch after shutdown begins",
      );
      assert.equal(
        reconciliations,
        stage === "inspect" ? 0 : 1,
        "Only an already-started reconciliation may finish",
      );
    } finally {
      release.resolve({ state: "closed" });
      await f.close();
    }
  });
}

await test("fresh explicit save retries reconstruct long active and completed replies without repeating mutation or revoking final replay", async () => {
  const f = await fixture();
  let invocations = 0;
  f.host.beforeSave = () => {
    invocations++;
    return Promise.resolve();
  };
  const command = {
    operationId: "long-retry",
    ref: f.document.ref,
    expectedRevision: f.document.revision,
    text: "A long Unicode reply 🦉\n".repeat(20_000),
  };
  try {
    const first = await f.client.save(
      { context: f.context, command },
      f.options,
    );
    let partial: { value?: ValueChunk | undefined; nextCursor: string } = first;
    for (let page = 0; page < 3; page++) {
      assert.notEqual(partial.nextCursor, "");
      partial = await f.client.result(
        { context: f.context, cursor: partial.nextCursor },
        f.options,
      );
    }
    const originalOutstanding = partial.nextCursor;
    assert.notEqual(originalOutstanding, "");
    // Both replies are discarded, as when the editor times out and drops its stage.
    const lost = await f.client.result(
      { context: f.context, cursor: originalOutstanding },
      f.options,
    );
    assert.notEqual(
      lost.nextCursor,
      "",
      "The result must exceed four continuation pages",
    );
    assert.deepEqual(
      await f.client.result(
        { context: f.context, cursor: originalOutstanding },
        f.options,
      ),
      lost,
    );
    const restarted = await f.client.save(
      { context: f.context, command },
      f.options,
    );
    assert.deepEqual(restarted, first);
    const forged = `${first.nextCursor.slice(0, -1)}${first.nextCursor.endsWith("0") ? "1" : "0"}`;
    await assert.rejects(
      f.client.result({ context: f.context, cursor: forged }, f.options),
      /expired/,
    );
    assert.equal(
      invocations,
      1,
      "The retained immutable result must not invoke the host again",
    );
    assert.deepEqual(
      await f.client.result(
        { context: f.context, cursor: originalOutstanding },
        f.options,
      ),
      lost,
    );
    const bytes: Uint8Array[] = [];
    let page: { value?: ValueChunk | undefined; nextCursor: string } =
      restarted;
    let finalCursor = "";
    for (;;) {
      assert.ok(page.value !== undefined);
      bytes.push(page.value.data);
      if (page.nextCursor === "") break;
      finalCursor = page.nextCursor;
      page = await f.client.result(
        { context: f.context, cursor: page.nextCursor },
        f.options,
      );
    }
    const reconstructed = fromJsonString(
      SaveResultSchema,
      Buffer.concat(bytes).toString("utf8"),
    );
    assert.equal(reconstructed.result.case, "accepted");
    assert.equal(reconstructed.result.value.document?.text, command.text);
    assert.equal(invocations, 1);
    assert.deepEqual(
      await f.client.result(
        { context: f.context, cursor: finalCursor },
        f.options,
      ),
      page,
    );
    // A lost final reply with no retained client stage reads the durable witness anew.
    const completedRetry = await f.result(
      await f.client.save({ context: f.context, command }, f.options),
      SaveResultSchema,
    );
    assert.deepEqual(completedRetry, reconstructed);
    assert.equal(invocations, 2);
    assert.equal(f.host.saveEffects, 1);
    assert.deepEqual(
      await f.client.result(
        { context: f.context, cursor: finalCursor },
        f.options,
      ),
      page,
      "Fresh witness retrieval preserves the prior final cursor tombstone",
    );
  } finally {
    await f.close();
  }
});
