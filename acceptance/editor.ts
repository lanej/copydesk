import assert from "node:assert/strict";
import { spawn, execFile, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { create, clone, equals } from "@bufbuild/protobuf";
import { createWorkspace } from "../src/index.js";
import { FakeHostProvider } from "../src/testing.js";
import type {
  AttachmentState,
  EditorLauncher,
  LaunchRequest,
} from "../src/host.js";
import {
  CallContextSchema,
  DocumentRefSchema,
  DocumentChangeSchema,
  DocumentSnapshotSchema,
  FeedbackRecordSchema,
  FeedbackState,
  SaveCommandSchema,
  type SaveCommand,
  type EditorRegistration,
} from "../src/generated/editorinterop/v1/editor_interop_pb.js";

const execute = promisify(execFile);
const nvim = process.env["COPYDESK_NVIM"] ?? "nvim";
const output = resolve(
  process.env["COPYDESK_ACCEPTANCE_OUTPUT"] ?? "artifacts/editor",
);
const directory = await mkdtemp(join(tmpdir(), "ei-"));
const rpc = join(directory, "nvim.sock");
let processHandle: ChildProcess | undefined;
let stderr = "";
const runtime = resolve("resources/nvim");
const assertions: string[] = [];
await mkdir(output, { recursive: true });
await mkdir(join(directory, "config/nvim"), { recursive: true });
await writeFile(
  join(directory, "config/nvim/init.lua"),
  `vim.g.editor_acceptance_init = true\nvim.g.maplocalleader = ','\nvim.o.winbar = 'User window'\nvim.notify = function(message) vim.g.editor_last_notice = message end\n`,
);
async function lua(code: string): Promise<unknown> {
  const expression =
    `luaeval('vim.json.encode((function() ${code} end)())')`.replaceAll(
      "\n",
      " ",
    );
  const { stdout } = await execute(
    nvim,
    ["--server", rpc, "--remote-expr", expression],
    { timeout: 8000 },
  );
  return JSON.parse(stdout.trim()) as unknown;
}
// Lua literals use JSON double quotes, so the enclosing Vim expression is stable.
async function wait(
  label: string,
  check: () => Promise<boolean> | boolean,
  timeout = 10000,
): Promise<void> {
  const until = Date.now() + timeout;
  let error: unknown;
  do {
    try {
      if (await check()) {
        assertions.push(label);
        return;
      }
    } catch (caught) {
      error = caught;
    }
    await new Promise((done) => setTimeout(done, 40));
  } while (Date.now() < until);
  console.error(
    await lua(
      doc +
        "return {notice=vim.g.editor_last_notice, revision=d and d.revision, incoming=d and d.incoming, save=d and d.save, saving=d and d.saving, modified=d and vim.bo[d.buffer].modified}",
    ),
  );
  throw new Error(
    `${label}: ${error instanceof Error ? error.message : "condition did not become true"}\n${stderr}`,
  );
}
async function capture(width: number, name: string): Promise<string> {
  const target = join(output, `${name}.txt`);
  await execute(
    nvim,
    [
      "--headless",
      "-u",
      "NONE",
      "-i",
      "NONE",
      "-l",
      resolve("acceptance/editor-capture.lua"),
    ],
    {
      env: {
        ...process.env,
        COPYDESK_CAPTURE_SOCKET: rpc,
        COPYDESK_CAPTURE_WIDTH: String(width),
        COPYDESK_CAPTURE_HEIGHT: "20",
        COPYDESK_CAPTURE_OUTPUT: target,
      },
      timeout: 10000,
    },
  );
  return readFile(target, "utf8");
}
const state = 'local s = require("copydesk").inspect(); ';
const doc =
  state +
  'local d; for _, candidate in pairs(s.documents) do if candidate.ref.documentId == "spec" then d = candidate end end; ';
const legacyLauncher = process.env["COPYDESK_ACCEPTANCE_LEGACY"] === "1";
const launcher: EditorLauncher = {
  ensure(request: LaunchRequest): Promise<AttachmentState> {
    if (processHandle === undefined) {
      processHandle = spawn(
        nvim,
        [
          "--headless",
          "-i",
          "NONE",
          "-n",
          "--listen",
          rpc,
          "-c",
          'lua dofile((vim.env.COPYDESK_RUNTIME or vim.env.EDITOR_INTEROP_RUNTIME) .. "/bootstrap.lua")',
        ],
        {
          cwd: directory,
          env: {
            ...process.env,
            XDG_CONFIG_HOME: join(directory, "config"),
            XDG_DATA_HOME: join(directory, "data"),
            XDG_STATE_HOME: join(directory, "state"),
            XDG_CACHE_HOME: join(directory, "cache"),
            COPYDESK_RUNTIME: legacyLauncher ? undefined : runtime,
            COPYDESK_CONNECTION: legacyLauncher
              ? undefined
              : request.manifestPath,
            EDITOR_INTEROP_RUNTIME: legacyLauncher ? runtime : undefined,
            EDITOR_INTEROP_CONNECTION: legacyLauncher
              ? request.manifestPath
              : undefined,
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      processHandle.stderr?.on("data", (value: Buffer) => {
        stderr += value.toString();
      });
    }
    return Promise.resolve({ state: "open", attachmentId: rpc });
  },
  inspect(): Promise<AttachmentState> {
    return Promise.resolve(
      processHandle?.exitCode == null
        ? { state: "open", attachmentId: rpc }
        : { state: "closed" },
    );
  },
  async verifyRegistration(request: LaunchRequest, editor: EditorRegistration) {
    assert.equal(editor.processId, processHandle?.pid);
    assert.equal(editor.rpcAddress, rpc);
    assert.equal(editor.launchId, request.launchId);
    assert.equal(await lua("return vim.fn.getpid()"), editor.processId);
    return {
      attachmentId: rpc,
      processIdentity: `native:${String(editor.processId)}`,
    };
  },
  dispose(): Promise<void> {
    return Promise.resolve();
  },
};
const context = create(CallContextSchema, {
  session: {
    providerId: "fake-host",
    projectId: "independent-project",
    conversationId: "native-chat",
  },
  generation: "activation-one",
});
const provider = new FakeHostProvider(context, "owner-one");
const initial = create(DocumentSnapshotSchema, {
  ref: { session: context.session, ownerId: "owner-one", documentId: "spec" },
  revision: "revision-one",
  title: "Specification",
  text: "# Specification\n\nUnicode 🦉 café.\nFourth line.\nUnselected context below.\n",
  writable: true,
});
assert(initial.ref !== undefined);
const plan = create(DocumentSnapshotSchema, {
  ...initial,
  ref: create(DocumentRefSchema, { ...initial.ref, documentId: "plan" }),
  revision: "plan-one",
  title: "Plan",
  text: "# Plan\n\nDo the useful thing.\n",
});
provider.seedDocument(initial);
provider.seedDocument(plan);
let workspace = await createWorkspace({
  context,
  provider,
  launcher,
  directory: join(directory, "host"),
  runtimePath: runtime,
  workingDirectory: directory,
  title: "Native editor acceptance",
});
try {
  const wireReport = await execute(
    nvim,
    [
      "--headless",
      "-u",
      "NONE",
      "-i",
      "NONE",
      "-l",
      resolve("acceptance/editor-wire.lua"),
    ],
    {
      env: {
        ...process.env,
        COPYDESK_RUNTIME: runtime,
        COPYDESK_FIXTURES: resolve("tests/fixtures"),
      },
      timeout: 180000,
    },
  );
  await writeFile(
    join(output, "wire-report.log"),
    wireReport.stdout + wireReport.stderr,
  );
  await workspace.open();
  await wait(
    "ordinary init and initial complete snapshot",
    async () =>
      (await lua(
        doc +
          "return vim.g.editor_acceptance_init and d ~= nil and s.connected and vim.tbl_count(s.documents) == 2",
      )) === true,
  );
  assert.equal(
    await lua(
      'return require("copydesk") == require("editor_interop") and vim.fn.exists(":CopydeskComment") == 2 and vim.fn.exists(":EditorComment") == 2',
    ),
    true,
  );
  await lua(doc + "vim.api.nvim_set_current_buf(d.buffer); return true");
  assert.equal(await lua(doc + "return vim.bo[d.buffer].filetype"), "markdown");
  assert.equal(
    await lua(doc + 'return vim.fn.maparg(",sc", "x", false, true).buffer'),
    1,
  );
  await lua(
    doc +
      'vim.api.nvim_buf_set_lines(d.buffer, 2, 3, false, {"Unsaved 🦉 selected text."}); return true',
  );
  const beforeCancel = provider.feedbackEffects;
  await lua('vim.api.nvim_input("3G,sc"); return true');
  await wait(
    "current-line comment opens beside the source window",
    async () =>
      (await lua(
        'return vim.bo.buftype == "prompt" and vim.api.nvim_win_get_config(0).relative == "win"',
      )) === true,
  );
  await lua('vim.api.nvim_input("Draft to cancel<Esc>"); return true');
  await wait(
    "cancel restores the original buffer",
    async () =>
      (await lua(
        doc +
          "return vim.api.nvim_get_current_buf() == d.buffer and #vim.api.nvim_tabpage_list_wins(0) == 1",
      )) === true,
  );
  assert.equal(provider.feedbackEffects, beforeCancel);

  await lua(
    legacyLauncher
      ? 'vim.api.nvim_input("3GVj:EditorComment<CR>"); return true'
      : 'vim.api.nvim_input("3GVj:CopydeskComment<CR>"); return true',
  );
  await wait(
    "selection comment enters the prompt",
    async () =>
      (await lua(
        'return vim.bo.buftype == "prompt" and vim.fn.mode() == "i"',
      )) === true,
  );
  await lua(
    'vim.api.nvim_input("Is this something we really want?"); return true',
  );
  const composer = await capture(90, "feedback-composer");
  const composerRows = composer.split("\n");
  const selectionEnd = composerRows.findIndex((line) =>
    line.includes("Fourth line."),
  );
  const promptRow = composerRows.findIndex((line) =>
    line.includes("Is this something we really want?"),
  );
  assert(
    selectionEnd >= 0 &&
      promptRow > selectionEnd &&
      promptRow <= selectionEnd + 2,
    composer,
  );
  assert(!composer.includes("Editor comment:"), composer);
  assert(composer.includes("Esc cancel"), composer);
  await lua('vim.api.nvim_input("<CR>"); return true');
  await wait(
    "exact dirty selection admitted without saving",
    () => provider.feedbackEffects === 1,
  );
  const queued = provider.feedback()[0];
  assert(queued?.request !== undefined);
  assert.equal(
    queued.request.selectedText,
    "Unsaved 🦉 selected text.\nFourth line.",
  );
  assert.equal(queued.request.message, "Is this something we really want?");
  assert.deepEqual(
    [queued.request.range?.startLine, queued.request.range?.endLine],
    [3, 4],
  );
  assert.equal(queued.request.baseRevision, "revision-one");
  assert.equal(provider.saveEffects, 0);
  assert.equal(
    provider.documents().find((value) => value.ref?.documentId === "spec")
      ?.text,
    initial.text,
  );
  const answered = create(FeedbackRecordSchema, {
    ...queued,
    state: FeedbackState.ANSWERED,
    summary: "Keep this requirement.",
    responseId: "actual-response-one",
  });
  provider.setFeedback(answered);
  await wait(
    "actual no-edit outcome rendered compactly",
    async () =>
      (await lua(
        doc +
          'local marks = vim.api.nvim_buf_get_extmarks(d.buffer, vim.api.nvim_get_namespaces().EditorDocuments, 0, -1, {details = true}); return vim.inspect(marks):find("no document edits", 1, true) ~= nil',
      )) === true,
  );
  let releaseSave!: () => void;
  provider.beforeSave = () =>
    new Promise<void>((done) => {
      releaseSave = done;
    });
  await lua('vim.cmd("write"); return true');
  await wait(
    "save reaches authoritative delay",
    () => typeof releaseSave === "function",
  );
  await lua(
    doc +
      'vim.api.nvim_buf_set_lines(d.buffer, 3, 4, false, {"Later local edit."}); return true',
  );
  releaseSave();
  await wait(
    "save acknowledgment preserves later local edit",
    async () =>
      (await lua(
        doc +
          'return not d.saving and d.save == nil and vim.bo[d.buffer].modified and vim.api.nvim_buf_get_lines(d.buffer, 3, 4, false)[1] == "Later local edit."',
      )) === true,
  );
  provider.beforeSave = undefined;
  await lua('vim.cmd("write"); return true');
  await wait(
    "explicit second write saves newer text",
    async () =>
      (await lua(
        doc + "return not d.saving and not vim.bo[d.buffer].modified",
      )) === true,
  );
  let current = provider
    .documents()
    .find((value) => value.ref?.documentId === "spec");
  assert(current !== undefined);
  const clean = clone(DocumentSnapshotSchema, current);
  clean.revision = "clean-incoming";
  clean.text =
    "# Specification\n\nClean incoming 🦉 text.\nLater local edit.\n";
  await lua(doc + "vim.api.nvim_win_set_cursor(0, {4, 2}); return true");
  provider.seedDocument(clean);
  await wait(
    "clean incoming preserves focus cursor and undo",
    async () =>
      (await lua(
        doc +
          'return d.revision == "clean-incoming" and vim.api.nvim_get_current_buf() == d.buffer and vim.api.nvim_win_get_cursor(0)[1] == 4 and vim.fn.undotree().seq_last > 0',
      )) === true,
  );
  await lua(
    doc +
      'vim.api.nvim_buf_set_lines(d.buffer, 2, 3, false, {"Dirty local conflict."}); return true',
  );
  const incoming = clone(DocumentSnapshotSchema, clean);
  incoming.revision = "dirty-incoming";
  incoming.text =
    "# Specification\n\nRemote conflicting text.\nLater local edit.\n";
  provider.seedDocument(incoming);
  await wait(
    "dirty incoming held with visible conflict",
    async () =>
      (await lua(
        doc +
          'return d.incoming ~= nil and vim.api.nvim_buf_get_lines(d.buffer, 2, 3, false)[1] == "Dirty local conflict." and vim.wo.winbar:find("conflict", 1, true) ~= nil',
      )) === true,
  );
  await lua('vim.cmd("normal! gg"); return true');
  const narrow = await capture(44, "documents-narrow");
  assert(narrow.includes("conflict") && narrow.includes("Answered"));
  const normal = await capture(100, "documents-normal");
  assert(normal.includes("conflict") && normal.includes("no document edits"));
  assertions.push(
    "actual narrow and normal UI grids retain conflict and outcome markers",
  );
  await lua('require("copydesk").resolve(); return true');
  assert.equal(await lua(doc + "return d.incoming ~= nil"), true);
  await lua(
    'require("copydesk").compare(); require("copydesk").resolve(); vim.cmd("write"); return true',
  );
  await wait(
    "explicit comparison reconciliation and write",
    async () =>
      (await lua(
        doc +
          "return d.incoming == nil and not d.saving and not vim.bo[d.buffer].modified",
      )) === true,
  );
  current = provider
    .documents()
    .find((value) => value.ref?.documentId === "spec");
  assert(current !== undefined);
  const changed = create(FeedbackRecordSchema, {
    ...answered,
    summary: "Changed the selected section.",
    changes: [
      create(DocumentChangeSchema, {
        ref: current.ref,
        beforeRevision: "clean-incoming",
        afterRevision: current.revision,
        range: { startLine: 3, endLine: 3 },
      }),
    ],
  });
  provider.setFeedback(changed);
  await wait(
    "correlated outcome change installed",
    async () =>
      (await lua(
        state +
          'for _, record in pairs(s.feedback) do local value = type(record) == "string" and s.client:read_receipt(record) or record; if value.summary == "Changed the selected section." then return true end end; return false',
      )) === true,
  );
  await lua(
    'vim.ui.select = function(items, _, callback) callback(items[1]) end; vim.cmd("CopydeskChanges"); return true',
  );
  assert.equal(await lua("return vim.api.nvim_win_get_cursor(0)[1]"), 3);
  await lua(
    doc +
      'vim.api.nvim_buf_set_lines(d.buffer, 2, 3, false, {"Dirty jump guard."}); vim.api.nvim_win_set_cursor(0, {1, 0}); vim.cmd("CopydeskChanges"); return true',
  );
  assert.equal(await lua("return vim.api.nvim_win_get_cursor(0)[1]"), 1);
  assertions.push("stale changed-location jump refused");
  // A lost acknowledgment after the atomic witness is reconciled by the exact
  // retained command. Newer text must never be attributed to that operation.
  const recoveryCommands: SaveCommand[] = [];
  provider.beforeSave = (command) => {
    recoveryCommands.push(clone(SaveCommandSchema, command));
    return Promise.resolve();
  };
  let releaseCommit!: () => void;
  provider.afterCommit = () =>
    new Promise<void>((done) => {
      releaseCommit = done;
    });
  await lua('vim.cmd("write"); return true');
  await wait(
    "unconfirmed save retained",
    async () =>
      (await lua(doc + "return not d.saving and d.save ~= nil")) === true,
  );
  const effects = provider.saveEffects;
  await lua(
    doc +
      'vim.api.nvim_buf_set_lines(d.buffer, 3, 4, false, {"Newer than uncertain save."}); return true',
  );
  releaseCommit();
  await workspace.dispose();
  provider.afterCommit = undefined;
  provider.activate("activation-recovery");
  workspace = await createWorkspace({
    context: create(CallContextSchema, {
      ...context,
      generation: "activation-recovery",
    }),
    provider,
    launcher,
    directory: join(directory, "host"),
    runtimePath: runtime,
    workingDirectory: directory,
    title: "Recover unconfirmed save",
  });
  await workspace.open();
  await lua('vim.cmd("CopydeskReconnect"); return true');
  await wait(
    "reconnect retains exact pending save without automatic replay",
    async () =>
      (await lua(
        doc +
          'return s.connected and d.save ~= nil and not d.saving and d.save.generation == "activation-one" and s.connection.context.generation == "activation-recovery" and vim.api.nvim_buf_get_lines(d.buffer, 3, 4, false)[1] == "Newer than uncertain save."',
      )) === true,
  );
  assert.equal(recoveryCommands.length, 1);
  assert.equal(provider.saveEffects, effects);
  await lua('vim.cmd("write"); return true');
  await wait(
    "explicit original operation reconciles after generation restart",
    async () =>
      (await lua(
        doc +
          "return not d.saving and d.save == nil and vim.bo[d.buffer].modified",
      )) === true,
  );
  assert.equal(provider.saveEffects, effects);
  assert.equal(recoveryCommands.length, 2);
  const originalCommand = recoveryCommands[0];
  const repeatedCommand = recoveryCommands[1];
  assert(originalCommand !== undefined && repeatedCommand !== undefined);
  assert(equals(SaveCommandSchema, originalCommand, repeatedCommand));
  assert.equal(
    await lua(
      doc + "return vim.api.nvim_buf_get_lines(d.buffer, 3, 4, false)[1]",
    ),
    "Newer than uncertain save.",
  );
  provider.beforeSave = undefined;
  provider.setActiveOwner(undefined);
  await wait(
    "missing owner preserves edits and detaches membership",
    async () =>
      (await lua(doc + "return d.detached and vim.bo[d.buffer].modified")) ===
      true,
  );
  await lua('vim.cmd("write"); return true');
  assert.equal(provider.saveEffects, effects);
  await workspace.dispose();
  await wait(
    "disconnect preserves buffers",
    async () =>
      (await lua(
        doc + "return not s.connected and vim.bo[d.buffer].modified",
      )) === true,
  );
  provider.activate("activation-two");
  provider.setActiveOwner("owner-one");
  const nextContext = create(CallContextSchema, {
    ...context,
    generation: "activation-two",
  });
  workspace = await createWorkspace({
    context: nextContext,
    provider,
    launcher,
    directory: join(directory, "host"),
    runtimePath: runtime,
    workingDirectory: directory,
    title: "Reconnected editor",
  });
  await workspace.open();
  await lua('vim.cmd("CopydeskReconnect"); return true');
  await wait(
    "explicit reconnect preserves terminal feedback and dirty buffers",
    async () =>
      (await lua(
        doc +
          'local terminal = false; for _, stored in pairs(s.feedback) do local receipt = type(stored) == "string" and s.client:read_receipt(stored) or stored; terminal = (receipt.state == "FEEDBACK_STATE_ANSWERED" or receipt.state == "answered") and receipt.responseId == "actual-response-one" and receipt.generation == "activation-one" end; return s.connected and not d.detached and vim.bo[d.buffer].modified and terminal and vim.wo.winbar:find("Editor", 1, true) ~= nil',
      )) === true,
  );
  await lua('vim.cmd("CopydeskReconnect"); return true');
  await wait(
    "same activation reconnect is idempotent",
    async () =>
      (await lua(doc + "return s.connected and vim.bo[d.buffer].modified")) ===
      true,
  );
  await lua(
    'local m = require("copydesk"); m.stop(); local c = vim.deepcopy(m.inspect().connection); c.context.session.conversationId = "foreign-conversation"; vim.g.foreign_reconnect_rejected = not pcall(m.setup, c); m.setup(); return true',
  );
  await wait(
    "foreign reconnect cannot retarget retained document identity",
    async () =>
      (await lua(
        doc +
          'return s.connected and vim.g.foreign_reconnect_rejected and d.ref.session.conversationId == "native-chat" and vim.bo[d.buffer].modified',
      )) === true,
  );
  const evidence = await lua(
    doc +
      "return { text = vim.api.nvim_buf_get_lines(d.buffer, 0, -1, false), status = vim.wo.winbar, marks = vim.api.nvim_buf_get_extmarks(d.buffer, vim.api.nvim_get_namespaces().EditorDocuments, 0, -1, {details = true}), init = vim.g.editor_acceptance_init }",
  );
  await writeFile(
    join(output, "native-state.json"),
    JSON.stringify(evidence, null, 2),
  );
  await writeFile(
    join(output, "report.json"),
    JSON.stringify(
      {
        status: "passed",
        assertions,
        nvim: (await execute(nvim, ["--version"])).stdout.split("\n")[0],
      },
      null,
      2,
    ),
  );
  console.log(
    `Native editor acceptance passed (${String(assertions.length)} checkpoints)`,
  );
} finally {
  await workspace.dispose();
  if (processHandle !== undefined && processHandle.exitCode == null) {
    try {
      await lua('vim.cmd("qa!"); return true');
    } catch {
      /* RPC closes with its process. */
    }
    await new Promise<void>((done) => {
      if (processHandle?.exitCode != null) {
        done();
        return;
      }
      processHandle?.once("exit", () => {
        done();
      });
    });
  }
  await writeFile(join(output, "nvim.log"), stderr);
  await rm(directory, { recursive: true, force: true });
}
