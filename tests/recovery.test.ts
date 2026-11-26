import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { lstat, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { create, fromJsonString } from "@bufbuild/protobuf";
import { createWorkspace, type EditorWorkspace } from "../src/index.js";
import {
  CallContextSchema,
  ConnectionManifestSchema,
  DocumentSnapshotSchema,
} from "../src/generated/editorinterop/v1/editor_interop_pb.js";
import { FakeHostProvider, FakeLauncher } from "../src/testing.js";

await test("a killed host leaves a stale socket and a fresh activation reuses its projection directory without unlinking that endpoint", async () => {
  const directory = await mkdtemp(join(process.platform === "darwin" ? "/private/tmp" : tmpdir(), "ei-crash-"));
  const child = spawn(
    process.execPath,
    [
      "--eval",
      `
    import { create } from '@bufbuild/protobuf';
    import { createWorkspace } from './src/index.ts';
    import { CallContextSchema, DocumentSnapshotSchema } from './src/generated/editorinterop/v1/editor_interop_pb.ts';
    import { FakeHostProvider, FakeLauncher } from './src/testing.ts';
    const context = create(CallContextSchema, { session: { providerId: 'recovery', projectId: 'project', conversationId: 'chat' }, generation: 'before-crash' });
    const host = new FakeHostProvider(context, 'owner');
    host.seedDocument(create(DocumentSnapshotSchema, { ref: { session: context.session, ownerId: 'owner', documentId: 'spec' }, revision: 'r1', title: 'Specification', text: 'Before crash', writable: true }));
    await createWorkspace({ context, provider: host, launcher: new FakeLauncher(), directory: process.env.COPYDESK_TEST_DIRECTORY, runtimePath: process.cwd() + '/resources/nvim', workingDirectory: process.cwd(), title: 'Crash test' });
    process.stdout.write('ready\\n');
  `,
    ],
    {
      cwd: process.cwd(),
      env: { ...process.env, COPYDESK_TEST_DIRECTORY: directory },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const exited = Promise.withResolvers<undefined>();
  const ready = Promise.withResolvers<undefined>();
  let output = "";
  let errors = "";
  let workspace: EditorWorkspace | undefined;
  child.stdout.on("data", (data: Buffer) => {
    output += data.toString("utf8");
    if (output.includes("ready\n")) ready.resolve(undefined);
  });
  child.stderr.on("data", (data: Buffer) => {
    errors += data.toString("utf8");
  });
  child.once("error", (error) => {
    ready.reject(error);
    exited.resolve(undefined);
  });
  child.once("exit", (code, signal) => {
    exited.resolve(undefined);
    ready.reject(new Error(`Crash fixture exited before readiness (${String(code)}/${String(signal)}): ${errors}`));
  });
  const timeout = setTimeout(
    () => {
      ready.reject(new Error(`Crash fixture readiness timed out: ${errors}`));
    },
    process.env["CI"] === undefined ? 5000 : 30_000,
  );
  try {
    await ready.promise;
    clearTimeout(timeout);
    const previous = fromJsonString(
      ConnectionManifestSchema,
      await readFile(join(directory, "connection.json"), "utf8"),
    );
    const originalFiles = await readdir(previous.projectionDirectory);
    assert.equal(originalFiles.length, 1);
    child.kill("SIGKILL");
    await exited.promise;
    assert.ok(
      (await lstat(previous.socketPath)).isSocket(),
      "SIGKILL must leave the owned Unix socket pathname behind",
    );
    const context = create(CallContextSchema, {
      session: previous.context?.session,
      generation: "after-crash",
    });
    const host = new FakeHostProvider(context, "owner");
    host.seedDocument(
      create(DocumentSnapshotSchema, {
        ref: { session: context.session, ownerId: "owner", documentId: "spec" },
        revision: "r2",
        title: "Specification",
        text: "After recovery",
        writable: true,
      }),
    );
    workspace = await createWorkspace({
      context,
      provider: host,
      launcher: new FakeLauncher(),
      directory,
      runtimePath: join(process.cwd(), "resources/nvim"),
      workingDirectory: process.cwd(),
      title: "Recovered",
    });
    const current = fromJsonString(ConnectionManifestSchema, await readFile(workspace.manifestPath, "utf8"));
    assert.notEqual(current.socketPath, previous.socketPath);
    assert.equal(current.projectionDirectory, previous.projectionDirectory);
    assert.deepEqual(await readdir(current.projectionDirectory), originalFiles);
    assert.ok((await lstat(previous.socketPath)).isSocket(), "Recovery must not remove an endpoint it did not create");
    assert.ok((await lstat(current.socketPath)).isSocket());
    await workspace.dispose();
    assert.ok((await lstat(previous.socketPath)).isSocket(), "Disposal removes only this activation endpoint");
  } finally {
    clearTimeout(timeout);
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await exited.promise;
    }
    await workspace?.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});
