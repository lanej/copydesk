# Copydesk

Review and revise Studio specifications and plans in Neovim. Copydesk opens full documents from the owning conversation, sends selected text and comments back to that conversation, and shows what changed after Studio responds.

Studio is the first host. It owns the drafts, conversation, validation, and approvals. Copydesk provides the editor connection and also works with other hosts that implement its interfaces.

## Use Copydesk with Studio

Enable Neovim and Zellij in Studio's configuration, then start or reload Studio inside a supported Zellij session.

```toml
[integrations.neovim]
enabled = true
executable = "nvim"

[integrations.zellij]
enabled = true
```

The first ready specification or plan opens in a centered floating pane, using your normal Neovim configuration. Studio keeps keyboard focus. Switch to the pane to edit. Later updates reuse it. If you close it, use `/documents` in Studio to reopen it. [Studio setup guide](https://github.com/lanej/studio/blob/main/docs/neovim-documents.md)

### Configure Neovim

Copydesk exposes actions through `require("copydesk")`. Put mappings in your Neovim configuration. The `User CopydeskAttach` event fires for each initialized document buffer and provides its buffer number in `event.data.buf`. Register the autocmd at startup and require Copydesk inside its callback, where the runtime is available.

```lua
vim.api.nvim_create_autocmd("User", {
  pattern = "CopydeskAttach",
  callback = function(event)
    local copydesk = require("copydesk")
    local opts = { buffer = event.data.buf }
    vim.keymap.set("n", "<localleader>sc", copydesk.comment, opts)
    vim.keymap.set("x", "<localleader>sc", copydesk.comment_selection, opts)
    vim.keymap.set("n", "<localleader>ss", copydesk.documents, opts)
  end,
})
```

| Lua action | Behavior |
| --- | --- |
| `documents()` | Choose a bound specification or plan. |
| `comment()` / `comment_selection()` | Prompt for a comment on the current line or the lines in the active Visual selection. |
| `responses()` / `changes()` | Inspect a short outcome or jump to its changes if the location still matches. |
| `compare()` / `resolve()` | Compare an incoming revision and adopt it as the base after merging locally. |
| `reload(true)` | Discard local edits and restore the incoming revision if present, otherwise the last known revision. Reconcile any pending save first. |
| `reconnect()` | Reconnect to the same document source when it is available. |

Use Neovim's `:write` to submit a revision-checked edit. Clean buffers follow changes from Studio. If a revision conflicts with unsaved text, compare it, merge locally, resolve it, then write again. Freezing and approval remain explicit Studio actions. The comment prompt sends the exact text, including unsaved edits, to the owning conversation. Enter sends and Escape cancels. The full response stays in Studio chat. [Recovery behavior](docs/architecture.md)

## Integrate another host

Copydesk is a private, source-pinned Bun package. Install from a full Copydesk commit SHA. Bun 1.4.5 or newer is required. Native acceptance uses Neovim 0.12.6 on Linux and macOS.

```json
{
  "dependencies": {
    "@lanej/copydesk": "git+https://github.com:443/lanej/copydesk.git#<full-commit-sha>"
  }
}
```

Implement [`HostProvider` and `EditorLauncher`](src/host.ts). The provider supplies authoritatively versioned documents, atomic saves and receipts, feedback admission, and change notifications. The launcher supplies editor process identity, attachment checks, and pane placement if applicable.

```ts
import { createWorkspace } from "@lanej/copydesk";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const workspace = await createWorkspace({
  context, // The host session identity and activation generation.
  provider,
  launcher,
  directory: privateSessionDirectory,
  runtimePath: dirname(fileURLToPath(import.meta.resolve("@lanej/copydesk/neovim"))),
  workingDirectory: projectDirectory,
  title: "Planning documents",
});

// For an explicit operator action after the editor was closed:
await workspace.open();
```

The launcher sets `COPYDESK_RUNTIME` and `COPYDESK_CONNECTION`, then loads `bootstrap.lua` after Neovim's ordinary startup. The runtime connects directly to the host over a private Unix socket. Call `workspace.dispose()` when the host ends the activation. Use `@lanej/copydesk/protocol` for generated schemas and `@lanej/copydesk/testing` for host-conformance cases. The package runs independently of Studio, Pi, Beads, and Zellij. [Host boundaries](docs/architecture.md) · [Protocol](docs/protocol.md)

## Upgrade from Editor Interop

- **Package.** Change the dependency key and import paths from `@lanej/editor-interop` to `@lanej/copydesk`, update the Git source and pin, and regenerate the consumer lockfile. The `/protocol`, `/neovim`, and `/testing` exports are unchanged. Use the Git transport shown above during the repository move. A Bun GitHub shorthand pin checks the archive checksum, which can change when the repository is renamed even at the same commit. If you maintain an older frozen checkout, update its dependency source and lockfile before reinstalling.
- **Neovim.** Replace mappings for old Ex commands with Lua callbacks configured on `CopydeskAttach`. The `require("editor_interop")` Lua entry point and the highlight and buffer metadata names remain available for existing integrations.
- **Launchers.** Use the `COPYDESK_*` variables. The bootstrap accepts `EDITOR_INTEROP_RUNTIME` and `EDITOR_INTEROP_CONNECTION` as fallbacks. The `editorinterop.v1.EditorInteropService` wire name and persisted manifest and document paths are unchanged.

## Verify a change

```sh
bun install --frozen-lockfile --ignore-scripts
npm ci --prefix .typescript-quality --ignore-scripts
python3 scripts/check-source-code.py typescript
bun run test:package
python3 scripts/check-protobuf.py tools
python3 scripts/check-source-code.py protobuf
bun run test:editor
```

The native test opens Neovim against an independent fixture host. Studio's own acceptance checks the full Studio, Zellij, and Neovim workflow. [License](LICENSE.md) · [Source and dependency notices](NOTICE.md)
