-- Attach a genuine Neovim UI grid without an external terminal or screenshot
-- dependency. The cells are read after redraw, not reconstructed from buffers.
local socket = assert(vim.env.COPYDESK_CAPTURE_SOCKET)
local width = tonumber(vim.env.COPYDESK_CAPTURE_WIDTH) or 100
local height = tonumber(vim.env.COPYDESK_CAPTURE_HEIGHT) or 24
local channel = vim.fn.sockconnect("pipe", socket, { rpc = true })
local ok, failure = pcall(function()
	vim.rpcrequest(channel, "nvim_ui_attach", width, height, { rgb = true })
	vim.rpcrequest(channel, "nvim_exec_lua", 'vim.cmd("redraw")', {})
	vim.wait(50)
	local lines = vim.rpcrequest(
		channel,
		"nvim_exec_lua",
		[[
    local width, height = ...
    local lines = {}
    for row = 1, height do
      local cells = {}
      for col = 1, width do table.insert(cells, vim.fn.screenstring(row, col)) end
      table.insert(lines, table.concat(cells))
    end
    return lines
  ]],
		{ width, height }
	)
	vim.fn.writefile(lines, assert(vim.env.COPYDESK_CAPTURE_OUTPUT))
end)
pcall(vim.rpcrequest, channel, "nvim_ui_detach")
vim.fn.chanclose(channel)
if not ok then
	error(failure)
end
vim.cmd("qa!")
