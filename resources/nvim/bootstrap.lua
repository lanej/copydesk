-- Loaded with -c after Neovim's normal configuration and plugin setup.
local runtime =
	assert(vim.env.COPYDESK_RUNTIME or vim.env.EDITOR_INTEROP_RUNTIME, "Editor runtime directory is missing")
local installed, copydesk = pcall(require, "copydesk")
if not installed then
	if not tostring(copydesk):match("^module 'copydesk' not found:") then
		error(copydesk)
	end
	vim.opt.runtimepath:prepend(vim.fs.dirname(vim.fs.dirname(vim.fs.normalize(runtime))))
	copydesk = require("copydesk")
end
assert(type(copydesk.attach) == "function", "Update the installed Copydesk plugin to attach to this host")
copydesk.attach()
