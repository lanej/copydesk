-- Loaded with -c after the user's ordinary init and plugins.
local runtime = assert(vim.env.EDITOR_INTEROP_RUNTIME, "Editor runtime directory is missing")
vim.opt.runtimepath:prepend(runtime)
require("editor_interop").setup()
