import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:http";
import { isAbsolute, join } from "node:path";
import { clone, create, equals, toJsonString } from "@bufbuild/protobuf";
import {
  Code,
  ConnectError,
  type HandlerContext,
  type Interceptor,
} from "@connectrpc/connect";
import { connectNodeAdapter } from "@connectrpc/connect-node";
import { createValidateInterceptor } from "@connectrpc/validate";
import {
  CallContextSchema,
  ConnectionManifestSchema,
  DocumentRefSchema,
  DocumentSnapshotSchema,
  EditorInteropService,
  EditorRegistrationSchema,
  FeedbackCommandSchema,
  FeedbackRecordSchema,
  SaveCommandSchema,
  SaveResultSchema,
  SyncHeaderSchema,
  ValueKind,
  type CallContext,
  type EditorRegistration,
} from "./generated/editorinterop/v1/editor_interop_pb.js";
import {
  ProviderError,
  type AttachmentState,
  type EditorWorkspace,
  type LaunchRequest,
  type WorkspaceOptions,
} from "./host.js";
import {
  assertContext,
  checked,
  CHUNK_BYTES,
  documentKey,
  REQUEST_BYTES,
  required,
  RESPONSE_BYTES,
  sameSession,
  SerialQueue,
} from "./model.js";
import { Projections } from "./projections.js";
import { OperationTransfers, SnapshotTransfer } from "./transfers.js";

/**
 * Starts one private, generation-bound editor workspace. runtimePath is the packaged
 * Neovim runtime directory. The host retains storage, admission and approval authority.
 * Dispose before replacing an activation; disposal never kills the user's editor.
 */
export async function createWorkspace(
  options: WorkspaceOptions,
): Promise<EditorWorkspace> {
  const activation = clone(
    CallContextSchema,
    checked(CallContextSchema, options.context),
  );
  if (!isAbsolute(options.directory) || !isAbsolute(options.runtimePath))
    throw new Error("Workspace and runtime paths must be absolute");
  await mkdir(options.directory, { recursive: true, mode: 0o700 });
  const stat = await lstat(options.directory);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    (stat.mode & 0o077) !== 0 ||
    (process.getuid !== undefined && stat.uid !== process.getuid())
  )
    throw new Error(
      "Workspace directory must be privately owned with mode 0700",
    );
  const directory = await realpath(options.directory);
  const projectionDirectory = join(directory, "documents");
  const spoolDirectory = join(directory, `transfers-${randomUUID()}`);
  await mkdir(projectionDirectory, { recursive: true, mode: 0o700 });
  const projectionStat = await lstat(projectionDirectory);
  if (
    projectionStat.isSymbolicLink() ||
    !projectionStat.isDirectory() ||
    (projectionStat.mode & 0o077) !== 0
  )
    throw new Error(
      "Projection directory must remain private and cannot be a symlink",
    );
  await mkdir(spoolDirectory, { mode: 0o700 });
  const socketPath = join(directory, `ipc-${randomBytes(8).toString("hex")}`);
  if (Buffer.byteLength(socketPath) > 100)
    throw new Error(
      "Workspace directory is too long for a portable Unix socket",
    );
  const manifestPath = join(directory, "connection.json");
  const queue = new SerialQueue();
  const registrations = new SerialQueue();
  const projections = new Projections(await realpath(projectionDirectory));
  const snapshots = new SnapshotTransfer(
    spoolDirectory,
    options.provider,
    activation,
    projections,
  );
  const results = new OperationTransfers(spoolDirectory);
  let token = randomBytes(32).toString("hex");
  let launchId = randomUUID();
  let registration: EditorRegistration | undefined;
  let attachment: AttachmentState = { state: "closed" };
  let attempted = false;
  let suppressed = false;
  let disposed = false;
  let backgroundFailure: unknown;
  let refreshPromise: Promise<void> | undefined;
  let refreshAgain = false;
  let launchRequest: LaunchRequest = makeLaunch(false);

  function isDisposed(): boolean {
    return disposed;
  }
  function needsRefresh(): boolean {
    return refreshAgain;
  }
  function makeLaunch(explicit: boolean): LaunchRequest {
    return {
      launchId,
      manifestPath,
      runtimePath: options.runtimePath,
      workingDirectory: options.workingDirectory,
      title: options.title,
      takeFocus: false,
      explicit,
    };
  }
  function validToken(header: string | null): boolean {
    const actual = Buffer.from(header ?? "");
    const expected = Buffer.from(`Bearer ${token}`);
    return (
      actual.length === expected.length && timingSafeEqual(actual, expected)
    );
  }
  function guard(
    context: CallContext | undefined,
    handler: HandlerContext,
  ): void {
    if (disposed || !validToken(handler.requestHeader.get("authorization")))
      throw new ConnectError("Invalid editor credential", Code.Unauthenticated);
    assertContext(context, activation);
    if (registration === undefined)
      throw new ConnectError(
        "Register the editor before using this workspace",
        Code.FailedPrecondition,
      );
  }
  function assertRunning(): void {
    if (isDisposed()) throw new Error("Workspace is disposed");
  }
  async function writeManifest(): Promise<void> {
    assertRunning();
    const manifest = create(ConnectionManifestSchema, {
      version: { major: 1, minor: 0 },
      socketPath,
      bearerToken: token,
      context: activation,
      launchId,
      projectionDirectory,
    });
    const temporary = `${manifestPath}.${randomUUID()}.tmp`;
    await writeFile(
      temporary,
      toJsonString(ConnectionManifestSchema, manifest),
      { mode: 0o600, flag: "wx" },
    );
    if (isDisposed()) {
      await rm(temporary, { force: true });
      assertRunning();
    }
    await rename(temporary, manifestPath);
  }
  async function ensureOpen(explicit: boolean): Promise<AttachmentState> {
    assertRunning();
    if (attachment.state === "open") {
      const inspected = await options.launcher.inspect(attachment.attachmentId);
      assertRunning();
      attachment = inspected;
      if (attachment.state === "open") return attachment;
      if (attachment.state === "closed") suppressed = true;
    }
    if (attachment.state === "uncertain") {
      if (!explicit) return attachment;
      const reconciled = await options.launcher.ensure({
        ...launchRequest,
        explicit: true,
      });
      assertRunning();
      attachment = reconciled;
      if (attachment.state !== "closed") return attachment;
    }
    if (!explicit && (suppressed || attempted)) return attachment;
    if (explicit && attempted) {
      await snapshots.close();
      assertRunning();
      await results.close();
      assertRunning();
      token = randomBytes(32).toString("hex");
      launchId = randomUUID();
      registration = undefined;
      await writeManifest();
      assertRunning();
    }
    assertRunning();
    suppressed = false;
    attempted = true;
    launchRequest = makeLaunch(explicit);
    try {
      attachment = await options.launcher.ensure(launchRequest);
    } catch (error) {
      attachment = {
        state: "uncertain",
        reason:
          error instanceof Error
            ? error.message
            : "Launcher outcome is unknown",
      };
    }
    assertRunning();
    return attachment;
  }
  async function refreshNow(): Promise<void> {
    const reader = await options.provider.openSnapshot(
      clone(CallContextSchema, activation),
    );
    let hasDocument = false;
    const seen = new Set<string>();
    try {
      checked(SyncHeaderSchema, reader.header);
      if (!sameSession(reader.header.session, activation.session))
        throw new ConnectError("Foreign projection session", Code.Internal);
      for (
        let item = await reader.next();
        item !== undefined;
        item = await reader.next()
      ) {
        if (item.kind !== "document") continue;
        checked(DocumentSnapshotSchema, item.value);
        const ref = required(item.value.ref, "document ref");
        if (
          !sameSession(ref.session, activation.session) ||
          ref.ownerId !== reader.header.activeOwnerId ||
          seen.has(documentKey(ref))
        )
          throw new ConnectError(
            "Invalid projection document membership",
            Code.Internal,
          );
        seen.add(documentKey(ref));
        hasDocument = true;
        await projections.update(item.value);
      }
    } finally {
      await reader.close();
    }
    if (hasDocument) await ensureOpen(false);
  }
  function refresh(): Promise<void> {
    if (disposed) return Promise.reject(new Error("Workspace is disposed"));
    if (refreshPromise !== undefined) {
      refreshAgain = true;
      return refreshPromise;
    }
    refreshPromise = queue
      .run(async () => {
        do {
          refreshAgain = false;
          await refreshNow();
          backgroundFailure = undefined;
        } while (needsRefresh() && !isDisposed());
      })
      .finally(() => {
        refreshPromise = undefined;
      });
    return refreshPromise;
  }
  const authenticate: Interceptor = (next) => async (request) => {
    if (disposed || !validToken(request.header.get("authorization")))
      throw new ConnectError("Invalid editor credential", Code.Unauthenticated);
    if (
      request.header.get("connect-protocol-version") !== "1" ||
      request.header.get("content-type")?.split(";")[0]?.trim() !==
        "application/json"
    ) {
      throw new ConnectError(
        "Application v1 requires Connect JSON protocol version 1",
        Code.InvalidArgument,
      );
    }
    try {
      return await next(request);
    } catch (error) {
      if (error instanceof ProviderError) {
        const codes = {
          invalid_argument: Code.InvalidArgument,
          failed_precondition: Code.FailedPrecondition,
          already_exists: Code.AlreadyExists,
        };
        throw new ConnectError(error.message, codes[error.code]);
      }
      throw error;
    }
  };
  const handler = connectNodeAdapter({
    grpc: false,
    grpcWeb: false,
    acceptCompression: [],
    jsonOptions: { ignoreUnknownFields: false },
    readMaxBytes: REQUEST_BYTES,
    writeMaxBytes: RESPONSE_BYTES,
    interceptors: [authenticate, createValidateInterceptor()],
    routes(router) {
      router.service(EditorInteropService, {
        register(request, context) {
          return registrations.run(async () => {
            if (
              disposed ||
              !validToken(context.requestHeader.get("authorization"))
            )
              throw new ConnectError(
                "Invalid editor credential",
                Code.Unauthenticated,
              );
            assertContext(request.context, activation);
            if (request.version?.major !== 1)
              throw new ConnectError(
                "No compatible Copydesk protocol version",
                Code.FailedPrecondition,
              );
            const editor = required(request.editor, "editor registration");
            if (
              editor.launchId !== launchId ||
              (registration !== undefined &&
                !equals(EditorRegistrationSchema, registration, editor))
            )
              throw new ConnectError(
                "Registration does not match the issued launch",
                Code.FailedPrecondition,
              );
            const capturedToken = token;
            const verified = await options.launcher.verifyRegistration(
              launchRequest,
              editor,
            );
            if (isDisposed() || token !== capturedToken)
              throw new ConnectError(
                "Activation changed during registration",
                Code.FailedPrecondition,
              );
            if (verified.processIdentity === "" || verified.attachmentId === "")
              throw new ConnectError(
                "Launcher did not verify process identity",
                Code.FailedPrecondition,
              );
            if (
              attachment.state === "open" &&
              attachment.attachmentId !== verified.attachmentId
            )
              throw new ConnectError(
                "Registration belongs to another attachment",
                Code.FailedPrecondition,
              );
            registration = editor;
            attachment = { state: "open", attachmentId: verified.attachmentId };
            return {
              context: activation,
              selectedVersion: { major: 1, minor: 0 },
              maxRequestBytes: REQUEST_BYTES,
              maxChunkBytes: CHUNK_BYTES,
            };
          });
        },
        sync(request, context) {
          return queue.run(async () => {
            guard(request.context, context);
            if (backgroundFailure !== undefined)
              throw new ConnectError(
                "Projection refresh failed; refresh the workspace explicitly",
                Code.Unavailable,
              );
            return snapshots.call(request.cursor);
          });
        },
        save(request, context) {
          return queue.run(async () => {
            guard(request.context, context);
            const command = required(request.command, "save command");
            if (!sameSession(command.ref?.session, activation.session))
              throw new ConnectError(
                "Foreign document session",
                Code.FailedPrecondition,
              );
            const key = `save:${createHash("sha256").update(toJsonString(SaveCommandSchema, command)).digest("hex")}`;
            const response = await results.start(
              key,
              ValueKind.SAVE_RESULT,
              SaveResultSchema,
              async () => {
                const result = checked(
                  SaveResultSchema,
                  await options.provider.save(
                    clone(CallContextSchema, activation),
                    clone(SaveCommandSchema, command),
                  ),
                );
                const value = result.result.value;
                if (
                  value === undefined ||
                  value.operationId !== command.operationId
                )
                  throw new ConnectError(
                    "Save receipt identity mismatch",
                    Code.Internal,
                  );
                if (result.result.case === "accepted") {
                  const document = required(
                    result.result.value.document,
                    "accepted document",
                  );
                  if (
                    document.ref === undefined ||
                    command.ref === undefined ||
                    !equals(DocumentRefSchema, document.ref, command.ref)
                  )
                    throw new ConnectError(
                      "Save receipt document mismatch",
                      Code.Internal,
                    );
                  // Refresh current authority; a recovered older witness cannot roll back projections.
                  try {
                    await refreshNow();
                  } catch (error) {
                    backgroundFailure = error;
                  }
                }
                return result;
              },
            );
            return { value: response.value, nextCursor: response.nextCursor };
          });
        },
        feedback(request, context) {
          return queue.run(async () => {
            guard(request.context, context);
            const command = required(request.command, "feedback command");
            if (!sameSession(command.ref?.session, activation.session))
              throw new ConnectError(
                "Foreign document session",
                Code.FailedPrecondition,
              );
            const response = await results.start(
              `feedback:${createHash("sha256").update(toJsonString(FeedbackCommandSchema, command)).digest("hex")}`,
              ValueKind.FEEDBACK,
              FeedbackRecordSchema,
              async () => {
                const record = checked(
                  FeedbackRecordSchema,
                  await options.provider.submitFeedback(
                    clone(CallContextSchema, activation),
                    clone(FeedbackCommandSchema, command),
                  ),
                );
                if (
                  record.request === undefined ||
                  !equals(FeedbackCommandSchema, record.request, command)
                )
                  throw new ConnectError(
                    "Feedback receipt identity mismatch",
                    Code.Internal,
                  );
                return record;
              },
            );
            return { value: response.value, nextCursor: response.nextCursor };
          });
        },
        result(request, context) {
          return queue.run(async () => {
            guard(request.context, context);
            return results.next(request.cursor);
          });
        },
      });
    },
  });
  const server = createServer(handler);
  let unsubscribe = () => {};
  let sweepTimer: ReturnType<typeof setInterval> | undefined;
  async function dispose(): Promise<void> {
    if (disposed) return;
    disposed = true;
    unsubscribe();
    if (sweepTimer !== undefined) clearInterval(sweepTimer);
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => {
        if (error !== undefined) reject(error);
        else resolve();
      }),
    );
    await queue.run(async () => {
      await snapshots.close();
      await results.close();
    });
    await options.launcher.dispose();
    await rm(spoolDirectory, { recursive: true, force: true });
    await rm(socketPath, { force: true });
  }
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, resolve);
    });
    await chmod(socketPath, 0o600);
    await writeManifest();
    unsubscribe = options.provider.onChanged(() => {
      refresh().catch((error: unknown) => {
        backgroundFailure = error;
      });
    });
    sweepTimer = setInterval(() => {
      queue
        .run(async () => {
          await snapshots.sweep();
          await results.sweep();
        })
        .catch((error: unknown) => {
          backgroundFailure = error;
        });
    }, 1000);
    sweepTimer.unref();
    await refresh();
    return {
      manifestPath,
      open: () => queue.run(() => ensureOpen(true)),
      refresh,
      dispose,
    };
  } catch (error) {
    if (server.listening) await dispose();
    else await rm(spoolDirectory, { recursive: true, force: true });
    throw error;
  }
}
