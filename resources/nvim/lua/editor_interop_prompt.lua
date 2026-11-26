local M = {}
local api = vim.api
local highlight = api.nvim_create_namespace("EditorCommentSelection")
local cancel_active

function M.cancel()
	if cancel_active then
		cancel_active()
	end
end

function M.open(buffer, first, last, submit)
	if cancel_active then
		return
	end
	local source = api.nvim_get_current_win()
	local view = vim.fn.winsaveview()
	local restore_sizes = vim.fn.winrestcmd()
	local tab = api.nvim_get_current_tabpage()
	local layout = vim.fn.winlayout()
	local rows = api.nvim_win_get_height(source)
	local scrolloff = vim.wo[source].scrolloff
	local focus_disabled = vim.w[source].focus_disable
	local minimum = math.max(1, vim.o.winminheight)
	local prompt_buffer = api.nvim_create_buf(false, true)
	local prompt, continuation, mark, group
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
			local focused = api.nvim_get_current_win()
			if api.nvim_win_is_valid(source) then
				vim.wo[source].scrolloff = scrolloff
				vim.w[source].focus_disable = focus_disabled
			end
			for _, window in ipairs({ continuation or 0, prompt or 0 }) do
				if window ~= 0 and api.nvim_win_is_valid(window) then
					api.nvim_win_close(window, true)
				end
			end
			if api.nvim_buf_is_valid(prompt_buffer) then
				api.nvim_buf_delete(prompt_buffer, { force = true })
			end
			if mark and api.nvim_buf_is_valid(buffer) then
				api.nvim_buf_del_extmark(buffer, highlight, mark)
			end
			if api.nvim_win_is_valid(source) and api.nvim_win_get_buf(source) == buffer then
				if focused == prompt or focused == continuation then
					api.nvim_set_current_win(source)
				end
				if api.nvim_get_current_tabpage() == tab and vim.deep_equal(vim.fn.winlayout(), layout) then
					vim.cmd(restore_sizes)
				end
				api.nvim_win_call(source, function()
					vim.fn.winrestview(view)
				end)
			end
			if value then
				submit(value)
			end
		end)
	end
	cancel_active = finish

	local label = first == last and ("Editor comment: [%d] "):format(first)
		or ("Editor comment: [%d–%d] "):format(first, last)
	vim.bo[prompt_buffer].buftype = "prompt"
	vim.bo[prompt_buffer].bufhidden = "wipe"
	-- Keep the input row fixed when a window auto-resizer is installed.
	vim.b[prompt_buffer].focus_disable = true
	vim.fn.prompt_setprompt(prompt_buffer, label)
	vim.fn.prompt_setcallback(prompt_buffer, finish)
	vim.fn.prompt_setinterrupt(prompt_buffer, finish)
	vim.keymap.set({ "i", "n" }, "<Esc>", function()
		finish()
	end, { buffer = prompt_buffer, nowait = true })

	local opened, failure = pcall(function()
		vim.w[source].focus_disable = true
		local visible_top = math.min(view.topline, last)
		local anchor_rows = api.nvim_win_text_height(source, {
			start_row = visible_top - 1,
			end_row = last - 1,
		}).all
		local source_rows = math.max(minimum, math.min(anchor_rows, rows - minimum - 2))
		if last < api.nvim_buf_line_count(buffer) and rows - source_rows >= 2 * minimum + 3 then
			-- A second view keeps the document below the input visible without copying its text.
			continuation = api.nvim_open_win(buffer, false, {
				split = "below",
				win = source,
				height = rows - source_rows - 1,
				noautocmd = true,
			})
			vim.w[continuation].focus_disable = true
			vim.wo[continuation].winbar = vim.go.winbar ~= "" and " " or ""
		end
		prompt = api.nvim_open_win(prompt_buffer, false, {
			split = continuation and "above" or "below",
			win = continuation or source,
			height = continuation and minimum or rows - source_rows - 1,
			noautocmd = true,
		})
		vim.w[prompt].focus_disable = true
		vim.wo[prompt].winbar = vim.go.winbar ~= "" and " " or ""
		vim.wo[prompt].number, vim.wo[prompt].relativenumber = false, false
		vim.wo[prompt].signcolumn, vim.wo[prompt].foldcolumn, vim.wo[prompt].statuscolumn = "no", "0", ""
		vim.wo[prompt].wrap = false
		vim.wo[source].scrolloff = 0
		if continuation then
			vim.wo[prompt].winfixheight = true
			vim.wo[continuation].scrolloff = 0
		end
		api.nvim_win_call(source, function()
			vim.fn.winrestview(vim.tbl_extend("force", view, { topline = visible_top, lnum = last, col = 0 }))
		end)
		mark = api.nvim_buf_set_extmark(buffer, highlight, first - 1, 0, {
			end_row = last,
			end_col = 0,
			hl_eol = true,
			hl_group = "Visual",
		})
		group = api.nvim_create_augroup("EditorCommentPrompt", { clear = true })
		api.nvim_create_autocmd("BufLeave", {
			group = group,
			buffer = prompt_buffer,
			callback = function()
				finish()
			end,
		})
		api.nvim_set_current_win(prompt)
		if continuation then
			api.nvim_win_set_height(prompt, math.max(1, vim.o.winminheight))
			api.nvim_win_call(continuation, function()
				vim.fn.winrestview({ topline = last + 1, lnum = last + 1, col = 0, skipcol = 0 })
			end)
		end
		vim.cmd.startinsert()
	end)
	if not opened then
		finish()
		vim.notify("Editor: Cannot open the comment input: " .. tostring(failure), vim.log.levels.WARN)
	end
end

return M
