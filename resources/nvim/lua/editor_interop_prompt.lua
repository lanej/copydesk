local M = {}
local api = vim.api
local highlight = api.nvim_create_namespace("EditorCommentSelection")
local cancel_active

function M.cancel()
	if cancel_active then
		cancel_active()
	end
end

local function placement(source, buffer, first, last)
	local cursor = api.nvim_win_get_cursor(source)
	local origin = vim.fn.win_screenpos(source)
	local tail = api.nvim_buf_get_lines(buffer, last - 1, last, false)[1] or ""
	local ending = vim.fn.screenpos(source, last, #tail + 1)
	local starting = vim.fn.screenpos(source, first, first == last and cursor[2] + 1 or 1)
	if ending.row == 0 then
		ending = vim.fn.screenpos(source, cursor[1], cursor[2] + 1)
	end
	if starting.row == 0 then
		starting = ending
	end

	local available = api.nvim_win_get_width(source)
	local width = math.max(1, math.min(58, available - 2))
	local col = math.max(0, math.min(starting.col - origin[2], available - width - 2))
	local bottom = vim.o.lines - vim.o.cmdheight
	local above = ending.row + 3 > bottom and starting.row > 3
	local top = origin[1] + ((vim.wo[source].winbar ~= "" or vim.go.winbar ~= "") and 1 or 0)
	local row = above and starting.row - top or math.max(1, ending.row - top + 1)
	return {
		relative = "win",
		win = source,
		anchor = above and "SW" or "NW",
		row = row,
		col = col,
		width = width,
		height = 1,
		border = "rounded",
		title = width >= 30
				and (first == last and (" Editor comment: line %d "):format(first) or (" Editor comment: lines %d–%d "):format(
					first,
					last
				))
			or " Comment ",
		footer = width >= 26 and " Enter send  ·  Esc cancel " or nil,
		footer_pos = "right",
		noautocmd = true,
		style = "minimal",
	}
end

function M.open(buffer, first, last, submit)
	if cancel_active then
		return
	end
	local source = api.nvim_get_current_win()
	local input = api.nvim_create_buf(false, true)
	local prompt, mark, group
	local settled = false
	local function finish(value)
		if settled then
			return
		end
		settled = true
		vim.schedule(function()
			cancel_active = nil
			if group then
				api.nvim_del_augroup_by_id(group)
			end
			if prompt and api.nvim_win_is_valid(prompt) then
				api.nvim_win_close(prompt, true)
			end
			if api.nvim_buf_is_valid(input) then
				api.nvim_buf_delete(input, { force = true })
			end
			if mark and api.nvim_buf_is_valid(buffer) then
				api.nvim_buf_del_extmark(buffer, highlight, mark)
			end
			if value then
				submit(value)
			end
		end)
	end
	cancel_active = finish

	vim.bo[input].buftype, vim.bo[input].bufhidden = "prompt", "wipe"
	vim.fn.prompt_setprompt(input, " › ")
	vim.fn.prompt_setcallback(input, finish)
	vim.fn.prompt_setinterrupt(input, finish)
	vim.keymap.set({ "i", "n" }, "<Esc>", function()
		finish()
	end, { buffer = input, nowait = true })

	local opened, failure = pcall(function()
		vim.cmd.redraw()
		prompt = api.nvim_open_win(input, true, placement(source, buffer, first, last))
		vim.wo[prompt].wrap, vim.wo[prompt].sidescrolloff = false, 0
		vim.wo[prompt].winhighlight = "FloatBorder:DiagnosticInfo,FloatTitle:Title,FloatFooter:DiagnosticInfo"
		mark = api.nvim_buf_set_extmark(buffer, highlight, first - 1, 0, {
			end_row = last,
			end_col = 0,
			hl_eol = true,
			hl_group = "Visual",
		})
		group = api.nvim_create_augroup("EditorCommentPrompt", { clear = true })
		api.nvim_create_autocmd("BufLeave", {
			group = group,
			buffer = input,
			callback = function()
				finish()
			end,
		})
		vim.cmd.startinsert()
	end)
	if not opened then
		finish()
		vim.notify("Editor: Cannot open the comment input: " .. tostring(failure), vim.log.levels.WARN)
	end
end

return M
