# Editor Interop

Edit host-owned Markdown documents in Neovim and send selected text with a message to their owning conversation. The host retains storage, validation, approvals and conversation authority. Studio is the first host adapter; the package and its native editor acceptance do not depend on Studio, Pi, Beads or Zellij.

The package targets Bun 1.4.5 or newer. Native acceptance uses Neovim 0.12.6 on macOS and Linux. The v1 API is provisional; consumers should pin an exact source revision.

## Integration

A host supplies two interfaces to `createWorkspace`:

| Interface | What the host supplies |
|---|---|
| `HostProvider` | Consistent document/feedback snapshots, revision-checked saves with atomic commit witnesses, durable feedback admission, and change notifications. |
| `EditorLauncher` | Launch/reuse, attachment inspection and process registration verification. A terminal multiplexer is optional. |

```ts
import { createWorkspace } from '@lanej/editor-interop';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const workspace = await createWorkspace({
  context, // Generated CallContext with opaque session IDs and activation generation.
  provider, // Your HostProvider implementation.
  launcher, // Your EditorLauncher implementation.
  directory: privateSessionDirectory,
  runtimePath: dirname(fileURLToPath(import.meta.resolve('@lanej/editor-interop/neovim'))),
  workingDirectory: projectDirectory,
  title: 'Planning documents',
});

// Explicit reopen after a manually closed editor:
await workspace.open();
// End this activation while preserving editor text and recovery evidence:
await workspace.dispose();
```

The package creates a private Unix socket, connection manifest and projection files. It opens the editor when the first draft is available, preserves focus and reuses a verified attachment. The launcher loads `bootstrap.lua` after normal user initialization and supplies `EDITOR_INTEROP_CONNECTION` and `EDITOR_INTEROP_RUNTIME`. See the [host interfaces](src/host.ts), [protocol](docs/protocol.md) and [authority boundaries](docs/architecture.md) for required behavior and failure handling. Generated wire schemas and types are exported from `@lanej/editor-interop/protocol`. Host authors can use `@lanej/editor-interop/testing` for an independent fixture provider/launcher and the shared host-conformance cases; these helpers do not implement production persistence.

## In Neovim

Use ordinary buffers and `:write` to submit an explicit save. Clean buffers follow accepted host revisions; dirty buffers retain local text and offer comparison and reconciliation. An interrupted request remains uncertain until authoritative evidence resolves it.

| Command | Action |
|---|---|
| `:EditorDocuments` | Inspect the bound documents. |
| `:EditorComment` | Attach a message to the current buffer line. |
| `:'<,'>EditorComment` | Attach a message to the actual selected buffer lines, including unsaved text. |
| `:EditorResponses` | Inspect concise request outcomes and revision-safe locations. |
| `:EditorChanges` | Inspect incoming changes. |
| `:EditorCompare` / `:EditorResolve` | Compare and reconcile a conflicting revision. |
| `:EditorReload` | Request fresh host state. |

Full answers remain in the host conversation. Receiving feedback does not mean it was answered, and an answer does not imply a conflicting edit was applied. Saving, reading and commenting never approve, freeze or dispatch a host workflow.

## Development

```sh
bun install --frozen-lockfile --ignore-scripts
npm ci --prefix .typescript-quality --ignore-scripts
python3 scripts/check-source-code.py typescript
python3 scripts/check-protobuf.py tools
python3 scripts/check-source-code.py protobuf
bun run test:editor
```

TypeScript checks include a structural import/cycle gate and contract tests. Protobuf checks use the explicit [initial schema baseline](api-baseline/README.md) until an integration-branch schema exists; later CI compares against the actual PR base. Native acceptance runs the real editor against a small independent host. Studio's full integration acceptance belongs to Studio.

Source and generated dependency provenance are recorded in [NOTICE.md](NOTICE.md).
