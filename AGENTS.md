# Editor Interop

Keep the interoperability package independently buildable and testable. Do not import Studio application types, Pi hooks, Beads/task-runtime implementations, or a specific pane launcher into the core. Hosts implement the package-owned document authority and conversation interfaces.

Use an environment-provided Bun satisfying the package minimum. Run the required strict checks and affected native Neovim acceptance. Preserve unsaved text, exact ownership, explicit saves, uncertain receipts and host approval authority. Keep Markdown paragraphs on one source line.
