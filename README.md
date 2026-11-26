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

### Edit, comment, and review

1. **Open a draft.** Use `:CopydeskDocuments` to choose the full specification or plan.
2. **Save an edit.** Edit the Markdown buffer and run `:write`. Studio validates the draft and accepts it against the revision you opened. Freezing the specification and approving the plan remain separate Studio actions.
3. **Ask about a passage.** Select lines and run `:'<,'>CopydeskComment`, or use `<localleader>sc`. With no selection the command attaches the current line. The prompt opens beside the text. Enter sends the comment with the exact selected text, including unsaved edits. Escape cancels. The full reply stays in Studio chat.
4. **See the outcome.** Use `:CopydeskResponses` for short outcomes and `:CopydeskChanges` to jump to resulting edits when their locations still match. An answer can also explain a decision without changing the document.

Clean buffers follow accepted Studio revisions. If you have unsaved edits, Copydesk holds the incoming revision for comparison. Use `:CopydeskCompare`, merge the text you want into your buffer, then run `:CopydeskResolve` and `:write`. Use `:CopydeskReload!` only when you want to discard local edits. If the connection drops, the draft stays in Neovim on a normal Studio quit. `:CopydeskReconnect` attempts to reconnect to the same document source when it is available. [Recovery behavior](docs/architecture.md)

## Integrate another host

Copydesk is a private, source-pinned Bun package. Install from a full Copydesk commit SHA. Bun 1.4.5 or newer is required. Native acceptance uses Neovim 0.12.6 on Linux and macOS.

```json
{
  "dependencies": {
    "@lanej/copydesk": "git+https://github.com:443/lanej/editor-interop.git#<full-commit-sha>"
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

- **Package.** Change the dependency key and import paths from `@lanej/editor-interop` to `@lanej/copydesk`, update the Git source and pin, and regenerate the consumer lockfile. The `/protocol`, `/neovim`, and `/testing` exports are unchanged. Use the Git pin shown above before moving to the new GitHub address. A Bun GitHub shorthand pin checks the archive checksum, which can change when the repository is renamed even at the same commit. If you maintain an older frozen checkout, update its dependency source and lockfile before reinstalling.
- **Neovim.** Migrate mappings to the `:Copydesk…` commands. Existing `:Editor…` aliases and the `require("editor_interop")` entry point still work. Existing highlight groups and buffer metadata retain their names for user themes and integrations.
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
