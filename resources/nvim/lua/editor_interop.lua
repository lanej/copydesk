local M = {}
local uv = vim.uv or vim.loop
local namespace = vim.api.nvim_create_namespace("EditorDocuments")
local update_namespace = vim.api.nvim_create_namespace("EditorDocumentUpdates")
local boundary_namespace = vim.api.nvim_create_namespace("EditorDocumentBoundaries")
local state = {
	documents = {},
	buffers = {},
	feedback = {},
	requests = {},
	windows = {},
	sequence = 0,
	epoch = 0,
	stopped = true,
}
local wire = require("editor_interop_wire")
local client_factory = require("editor_interop_client")
local comment_prompt = require("editor_interop_prompt")

local function notify(message, level)
	vim.notify("Editor: " .. message, level or vim.log.levels.INFO)
end

local function compact(value, length)
	value = (value or ""):gsub("[%c]", " ")
	return vim.fn.strchars(value) > length and (vim.fn.strcharpart(value, 0, length) .. "…") or value
end

local function id()
	state.sequence = state.sequence + 1
	return string.format("%x-%x-%x", vim.fn.getpid(), uv.hrtime(), state.sequence)
end

local key = wire.key
local function valid_ref(ref)
	return pcall(wire.validate, "DocumentRef", ref)
end
local function valid_snapshot(snapshot)
	return type(snapshot) == "table" and snapshot.ref ~= nil and type(snapshot.text) == "string"
end

local function buffer_text(buffer)
	local value = table.concat(vim.api.nvim_buf_get_lines(buffer, 0, -1, false), "\n")
	return value .. (vim.bo[buffer].endofline and "\n" or "")
end

local function lines_of(text)
	local lines = vim.split(text, "\n", { plain = true })
	local eol = text:sub(-1) == "\n"
	if eol then
		table.remove(lines)
	end
	if #lines == 0 then
		lines = { "" }
	end
	return lines, eol
end

local function each_document(callback)
	for _, document in pairs(state.documents) do
		if vim.api.nvim_buf_is_valid(document.buffer) then
			callback(document)
		end
	end
end

local function request(method, params, callback)
	if not state.client or not state.client.registered then
		callback(nil, { code = "disconnected", message = "Document connection is not registered" })
		return
	end
	if method == "sync" then
		state.client:sync(callback)
	else
		state.client:operation(method == "save" and "Save" or "Feedback", params, callback)
	end
end

local function feedback_value(value)
	if type(value) == "string" then
		value = state.client:read_receipt(value)
	end
	if not value.request then
		return value
	end
	local record = vim.deepcopy(value.request)
	record.state = value.state:gsub("^FEEDBACK_STATE_", ""):lower()
	record.generation, record.reason, record.summary = value.generation, value.reason, value.summary
	record.responseId, record.changes = value.responseId, value.changes
	return record
end

local function document_for(buffer)
	return state.buffers[buffer or vim.api.nvim_get_current_buf()]
end

local function require_document()
	local document = document_for()
	if not document then
		notify("This buffer is not a managed document", vim.log.levels.WARN)
	end
	return document
end

local function status(document, compact)
	if not state.connected then
		return "disconnected"
	end
	if document.detached then
		return "inactive document"
	end
	if document.saving then
		return "saving"
	end
	if document.save then
		return compact and "save unconfirmed" or "save unconfirmed — :write to reconcile"
	end
	if document.incoming then
		return compact and "conflict" or "conflict — :EditorCompare"
	end
	if not document.writable then
		return compact and "protected" or document.reason or "protected — reopen in host"
	end
	if vim.bo[document.buffer].modified then
		return "unsaved"
	end
	return document.updated and "updated" or "saved"
end

local feedback_labels = {
	queued = "Queued",
	dispatching = "Sending",
	awaiting = "Awaiting response",
	parked = "Parked",
	answered = "Answered",
	failed = "Failed",
	uncertain = "Unconfirmed",
}

local function selection_line(buffer, feedback)
	local selected = vim.split(feedback.selectedText or "", "\n", { plain = true })
	local lines = vim.api.nvim_buf_get_lines(buffer, 0, -1, false)
	local found
	for start = 1, #lines - #selected + 1 do
		local matches = true
		for offset, line in ipairs(selected) do
			if lines[start + offset - 1] ~= line then
				matches = false
				break
			end
		end
		if matches then
			if found then
				return 0, true
			end
			found = start - 1
		end
	end
	return found or 0, found == nil
end

local function restore_window(window)
	local previous = state.windows[window]
	if previous and vim.api.nvim_win_is_valid(window) then
		vim.wo[window].conceallevel = previous.conceallevel
		vim.wo[window].concealcursor = previous.concealcursor
		vim.wo[window].winbar = previous.winbar
	end
	state.windows[window] = nil
end

local function window_status(window, document)
	local label = " Editor · " .. status(document, true) .. " · " .. compact(document.title, 80)
	local highlight = document.incoming and "EditorDocumentPending" or "EditorDocumentStatus"
	vim.wo[window].winbar = "%#" .. highlight .. "#" .. label:gsub("%%", "%%%%")
end

local function enter_document_window(buffer)
	local window = vim.api.nvim_get_current_win()
	if state.windows[window] and state.windows[window].buffer == buffer then
		return
	end
	restore_window(window)
	local previous = {
		buffer = buffer,
		conceallevel = vim.wo[window].conceallevel,
		concealcursor = vim.wo[window].concealcursor,
		winbar = vim.wo[window].winbar,
	}
	-- A split inherits the document window's temporary options, not its baseline.
	for _, other in pairs(state.windows) do
		if other.buffer == buffer then
			previous.conceallevel, previous.concealcursor = other.conceallevel, other.concealcursor
			previous.winbar = other.winbar
			break
		end
	end
	state.windows[window] = previous
	vim.wo[window].conceallevel, vim.wo[window].concealcursor = 2, "nc"
	window_status(window, state.buffers[buffer])
end

local function conceal_boundaries(document)
	local buffer = document.buffer
	local changedtick = vim.api.nvim_buf_get_changedtick(buffer)
	if document.boundary_tick == changedtick then
		return
	end
	document.boundary_tick = changedtick
	vim.api.nvim_buf_clear_namespace(buffer, boundary_namespace, 0, -1)
	local lines = vim.api.nvim_buf_get_lines(buffer, 0, -1, false)
	-- Standalone Markdown HTML comments are metadata for many hosts. Conceal
	-- only their presentation; insertion mode and ordinary editing retain bytes.
	for index, line in ipairs(lines) do
		if line:match("^<!%-%- .* %-%->$") then
			vim.api.nvim_buf_set_extmark(
				buffer,
				boundary_namespace,
				index - 1,
				0,
				{ end_col = #line, conceal = "", conceal_lines = "" }
			)
		end
	end
end

local function render(document)
	local buffer = document.buffer
	if not vim.api.nvim_buf_is_valid(buffer) then
		return
	end
	conceal_boundaries(document)
	vim.api.nvim_buf_clear_namespace(buffer, namespace, 0, -1)
	for _, window in ipairs(vim.fn.win_findbuf(buffer)) do
		if state.windows[window] then
			window_status(window, document)
		end
	end
	for _, stored in pairs(state.feedback) do
		local feedback = feedback_value(stored)
		if valid_ref(feedback.ref) and key(feedback.ref) == document.key then
			local line, stale = selection_line(buffer, feedback)
			local label = feedback_labels[feedback.state] or "Unknown"
			if feedback.state == "answered" and feedback.summary then
				label = label .. " · " .. compact(feedback.summary, 80)
			end
			if feedback.state == "answered" and #(feedback.changes or {}) == 0 then
				label = label .. " · no document edits"
			end
			if stale then
				label = label .. " · original selection moved"
			end
			if document.incoming and feedback.state == "answered" then
				label = label .. " · update held"
			end
			vim.api.nvim_buf_set_extmark(buffer, namespace, line, 0, {
				virt_text = {
					{
						"  " .. label:gsub("[\r\n]", " "),
						feedback.state == "answered" and "EditorDocumentAnswer" or "EditorDocumentPending",
					},
				},
				virt_text_pos = "eol",
			})
		end
	end
end

local function retain_views(buffer)
	local views = {}
	for _, window in ipairs(vim.fn.win_findbuf(buffer)) do
		if vim.api.nvim_win_is_valid(window) then
			views[window] = vim.api.nvim_win_call(window, vim.fn.winsaveview)
		end
	end
	return function()
		for window, view in pairs(views) do
			if vim.api.nvim_win_is_valid(window) and vim.api.nvim_win_get_buf(window) == buffer then
				pcall(vim.api.nvim_win_call, window, function()
					vim.fn.winrestview(view)
				end)
			end
		end
	end
end

local function set_text(document, markdown, clean)
	local buffer = document.buffer
	local restore = retain_views(buffer)
	local lines, eol = lines_of(markdown)
	vim.bo[buffer].modifiable = true
	vim.api.nvim_buf_set_lines(buffer, 0, -1, false, lines)
	vim.bo[buffer].endofline = eol
	vim.bo[buffer].modified = not clean
	vim.bo[buffer].modifiable = document.writable or not clean
	restore()
end

local function apply_snapshot(document, snapshot, force)
	if key(snapshot.ref) ~= document.key then
		error("Editor document identity changed")
	end
	document.detached = false
	document.writable, document.reason, document.title = snapshot.writable, snapshot.reason, snapshot.title
	vim.bo[document.buffer].modifiable = snapshot.writable or vim.bo[document.buffer].modified
	if snapshot.revision == document.revision then
		render(document)
		return
	end
	if (vim.bo[document.buffer].modified or document.save) and not force then
		document.incoming = snapshot
		render(document)
		return
	end
	local first = document.revision == nil
	document.revision, document.text = snapshot.revision, snapshot.text
	document.incoming = nil
	set_text(document, snapshot.text, true)
	document.updated = not first
	if not first then
		vim.api.nvim_buf_clear_namespace(document.buffer, update_namespace, 0, -1)
		vim.api.nvim_buf_set_extmark(document.buffer, update_namespace, 0, 0, {
			sign_text = "↻",
			sign_hl_group = "EditorDocumentAnswer",
		})
	end
	render(document)
end

local function save_document(document)
	if document.saving then
		notify("A save is awaiting acknowledgment")
		return
	end
	if document.detached then
		notify("Return to this document owner in the host before saving", vim.log.levels.WARN)
		return
	end
	if not document.writable and not document.save then
		notify(document.reason or "Reopen this document in the host before editing", vim.log.levels.WARN)
		return
	end
	if document.incoming and not document.save then
		notify("Compare and reconcile the incoming revision before saving", vim.log.levels.WARN)
		return
	end
	local buffer = document.buffer
	local retrying = document.save ~= nil
	local pending = document.save
		or {
			operationId = id(),
			ref = vim.deepcopy(document.ref),
			expectedRevision = document.revision,
			text = buffer_text(buffer),
			changedtick = vim.api.nvim_buf_get_changedtick(buffer),
			generation = state.connection.context.generation,
		}
	-- setup() has already verified the same session. An explicit write may
	-- recover this exact operation's durable witness after activation changes;
	-- the captured command and later buffer edits remain separate.
	document.save, document.saving = pending, true
	state.epoch = state.epoch + 1
	render(document)
	request("save", {
		operationId = pending.operationId,
		ref = pending.ref,
		expectedRevision = pending.expectedRevision,
		text = pending.text,
	}, function(result, err)
		document.saving = false
		state.epoch = state.epoch + 1
		if state.stopped then
			return
		end
		if not vim.api.nvim_buf_is_valid(buffer) then
			return
		end
		if err then
			if
				not retrying
				and (
					err.code == "invalid_argument"
					or err.code == "failed_precondition"
					or err.code == "unauthenticated"
					or err.code == "resource_exhausted"
				)
			then
				document.save = nil
			end
			notify(err.message .. (document.save and "; :write retries this same save" or ""), vim.log.levels.WARN)
			render(document)
			return
		end
		if result.uncertain then
			notify(result.uncertain.reason .. "; :write reconciles this same save", vim.log.levels.WARN)
			render(document)
			return
		end
		if result.rejected then
			document.save = nil
			if result.rejected.current then
				apply_snapshot(document, result.rejected.current, false)
			end
			notify(result.rejected.reason, vim.log.levels.WARN)
			render(document)
			return
		end
		local snapshot = result.accepted.document
		if not valid_snapshot(snapshot) or key(snapshot.ref) ~= document.key then
			notify("Save acknowledgment has the wrong document identity", vim.log.levels.ERROR)
			render(document)
			return
		end
		document.save = nil
		document.revision, document.text = snapshot.revision, snapshot.text
		document.writable, document.reason, document.title = snapshot.writable, snapshot.reason, snapshot.title
		local unchanged = vim.api.nvim_buf_get_changedtick(buffer) == pending.changedtick
			and buffer_text(buffer) == pending.text
		if unchanged then
			set_text(document, snapshot.text, true)
		else
			vim.bo[buffer].modified = true
			notify("Submitted revision saved; newer buffer edits remain unsaved")
		end
		if document.incoming and document.incoming.revision == snapshot.revision then
			document.incoming = nil
		end
		document.updated = false
		render(document)
		vim.api.nvim_exec_autocmds("BufWritePost", { buffer = buffer, modeline = false })
	end)
end

local function create_document(snapshot, projection_path)
	local document_key = key(snapshot.ref)
	local buffer = vim.api.nvim_create_buf(true, false)
	local document = {
		key = document_key,
		buffer = buffer,
		ref = vim.deepcopy(snapshot.ref),
		title = snapshot.title,
		writable = snapshot.writable,
	}
	state.documents[document_key], state.buffers[buffer] = document, document
	local path = assert(projection_path, "Missing issued projection path")
	assert(vim.fn.bufnr(path) == -1, "Issued projection is already open outside this connection")
	vim.api.nvim_buf_set_name(buffer, path)
	vim.bo[buffer].buftype, vim.bo[buffer].bufhidden = "acwrite", "hide"
	vim.bo[buffer].swapfile, vim.bo[buffer].modeline = false, false
	vim.bo[buffer].filetype = "markdown"
	vim.bo[buffer].undofile = false
	vim.b[buffer].editor_interop_document_ref = vim.deepcopy(snapshot.ref)
	vim.api.nvim_create_autocmd({ "BufEnter", "BufWinEnter" }, {
		group = state.group,
		buffer = buffer,
		callback = function()
			enter_document_window(buffer)
		end,
	})
	vim.api.nvim_create_autocmd("BufWinLeave", {
		group = state.group,
		buffer = buffer,
		callback = function()
			restore_window(vim.api.nvim_get_current_win())
		end,
	})
	vim.api.nvim_create_autocmd("BufWriteCmd", {
		group = state.group,
		buffer = buffer,
		callback = function()
			save_document(document)
		end,
	})
	vim.api.nvim_create_autocmd({ "TextChanged", "TextChangedI", "BufEnter" }, {
		group = state.group,
		buffer = buffer,
		callback = function()
			render(document)
		end,
	})
	vim.keymap.set(
		{ "n", "x" },
		"<localleader>sc",
		":EditorComment<CR>",
		{ buffer = buffer, desc = "Send Editor document comment" }
	)
	vim.keymap.set(
		"n",
		"<localleader>sr",
		"<Cmd>EditorResponses<CR>",
		{ buffer = buffer, desc = "Inspect Editor responses" }
	)
	vim.keymap.set(
		"n",
		"<localleader>sd",
		"<Cmd>EditorChanges<CR>",
		{ buffer = buffer, desc = "Jump to Editor changes" }
	)
	apply_snapshot(document, snapshot, true)
	if not state.opened then
		state.opened = true
		local current = vim.api.nvim_get_current_buf()
		if not vim.bo[current].modified then
			vim.bo[current].bufhidden = "hide"
			vim.api.nvim_set_current_buf(buffer)
		end
	end
	return document
end

local function keep_feedback(request_id, value)
	local previous = state.feedback[request_id] and feedback_value(state.feedback[request_id])
	local candidate = feedback_value(value)
	if
		previous
		and (previous.state == "answered" or previous.state == "failed")
		and candidate.state ~= previous.state
	then
		return
	end
	state.feedback[request_id] = value
end
local function update_feedback(records)
	for request_id, path in pairs(records) do
		keep_feedback(request_id, path)
	end
end

function M.sync()
	if state.stopped or state.syncing then
		return
	end
	-- A read started before a save acknowledgment cannot establish the new base.
	for _, document in pairs(state.documents) do
		if document.saving then
			return
		end
	end
	state.syncing = true
	local epoch = state.epoch
	request("sync", {}, function(result, err)
		state.syncing = false
		if state.stopped then
			return
		end
		if state.epoch ~= epoch then
			return
		end
		if err then
			if state.last_error ~= err.message then
				state.last_error = err.message
				notify(err.message, vim.log.levels.WARN)
			end
			state.connected = false
			each_document(render)
			return
		end
		if type(result) ~= "table" or type(result.documents) ~= "table" or type(result.feedback) ~= "table" then
			if state.connected then
				notify("Invalid synchronization reply", vim.log.levels.ERROR)
			end
			state.connected = false
			each_document(render)
			return
		end
		state.connected, state.last_error = true, nil
		local seen = {}
		for _, view in ipairs(result.documents) do
			local snapshot = view.document
			if valid_snapshot(snapshot) then
				local document_key = key(snapshot.ref)
				seen[document_key] = true
				local document = state.documents[document_key]
				if not document or not vim.api.nvim_buf_is_valid(document.buffer) then
					create_document(snapshot, view.projectionPath)
				else
					apply_snapshot(document, snapshot, false)
				end
			end
		end
		update_feedback(result.feedback)
		each_document(function(document)
			document.detached = not seen[document.key]
			render(document)
		end)
	end)
end

local function show_document(document, line)
	if not vim.api.nvim_buf_is_valid(document.buffer) then
		notify("Document buffer is no longer open", vim.log.levels.WARN)
		return
	end
	vim.api.nvim_set_current_buf(document.buffer)
	if line then
		vim.api.nvim_win_set_cursor(0, { math.min(math.max(line, 1), vim.api.nvim_buf_line_count(document.buffer)), 0 })
		vim.cmd("normal! zv")
	end
end

local function document_list()
	local list = {}
	each_document(function(document)
		table.insert(list, document)
	end)
	table.sort(list, function(a, b)
		return a.key < b.key
	end)
	return list
end

local function feedback_list(document)
	local list = {}
	for _, stored in pairs(state.feedback) do
		local feedback = feedback_value(stored)
		if not document or key(feedback.ref) == document.key then
			table.insert(list, feedback)
		end
	end
	table.sort(list, function(a, b)
		return a.requestId < b.requestId
	end)
	return list
end

local function choose_feedback(callback)
	local document = require_document()
	if not document then
		return
	end
	local list = feedback_list(document)
	if #list == 0 then
		notify("No comments on this document")
		return
	end
	vim.ui.select(list, {
		prompt = "Editor comments",
		format_item = function(item)
			return (feedback_labels[item.state] or item.state) .. " · " .. compact(item.message, 100)
		end,
	}, callback)
end

local function show_changes(feedback)
	if not feedback then
		return
	end
	local changes = feedback.changes or {}
	if #changes == 0 then
		local status = feedback.state == "answered" and "No document edits. " or "No document edits recorded. "
		notify(status .. (feedback.summary or feedback.reason or ""))
		return
	end
	vim.ui.select(changes, {
		prompt = "Changed document locations",
		format_item = function(change)
			return change.ref.documentId
				.. " · "
				.. (change.sectionId or ("line " .. tostring((change.range or {}).startLine or 1)))
		end,
	}, function(change)
		if not change then
			return
		end
		local document = state.documents[key(change.ref)]
		if not document then
			notify("That document is not available in this editor", vim.log.levels.WARN)
			return
		end
		if document.revision ~= change.afterRevision or document.incoming or vim.bo[document.buffer].modified then
			notify(
				"Change location belongs to another revision; inspect the response and current document",
				vim.log.levels.WARN
			)
			return
		end
		show_document(document, (change.range or {}).startLine or 1)
	end)
end

function M.comment(first_line, last_line, supplied_message)
	local document = require_document()
	if not document then
		return
	end
	if document.detached or not state.connected then
		notify("Return to this document owner in the host before commenting", vim.log.levels.WARN)
		return
	end
	local buffer = document.buffer
	local count = vim.api.nvim_buf_line_count(buffer)
	first_line = math.max(1, math.min(first_line or vim.fn.line("."), count))
	last_line = math.max(first_line, math.min(last_line or first_line, count))
	local request_value = {
		requestId = id(),
		ref = vim.deepcopy(document.ref),
		baseRevision = document.revision,
		bufferIdentity = vim.fn.sha256(buffer_text(buffer)),
		range = { startLine = first_line, endLine = last_line },
		selectedText = table.concat(vim.api.nvim_buf_get_lines(buffer, first_line - 1, last_line, false), "\n"),
	}
	local generation = state.connection.context.generation
	local function submit(message)
		if message == nil or message:match("^%s*$") then
			return
		end
		if generation ~= state.connection.context.generation or document.detached or not state.connected then
			notify("The comment's captured owner is no longer active; text was not submitted", vim.log.levels.WARN)
			return
		end
		request_value.message = message
		local local_record = vim.deepcopy(request_value)
		local_record.state = "dispatching"
		local_record.generation = state.connection.context.generation
		state.feedback[request_value.requestId] = local_record
		render(document)
		request("feedback", request_value, function(record, err)
			if err then
				local certain = err.code == "invalid_argument"
					or err.code == "failed_precondition"
					or err.code == "unauthenticated"
					or err.code == "resource_exhausted"
					or err.code == "already_exists"
				local_record.state = certain and "failed" or "uncertain"
				local_record.reason = err.message
				notify(err.message, vim.log.levels.WARN)
			elseif record and record.request then
				keep_feedback(record.request.requestId, feedback_value(record))
			else
				local_record.state, local_record.reason = "uncertain", "Invalid feedback acknowledgment"
			end
			render(document)
		end)
	end
	if supplied_message ~= nil then
		submit(supplied_message)
	else
		comment_prompt.open(buffer, first_line, last_line, submit)
	end
end

function M.compare()
	local document = require_document()
	if not document then
		return
	end
	if not document.incoming then
		notify("No incoming conflict to compare")
		return
	end
	local incoming = document.incoming
	local local_window = vim.api.nvim_get_current_win()
	vim.cmd("vsplit")
	local incoming_window = vim.api.nvim_get_current_win()
	local buffer = vim.api.nvim_create_buf(false, true)
	vim.api.nvim_buf_set_name(
		buffer,
		"editor_interop-incoming://" .. id() .. "/" .. compact(document.title, 80) .. ".md"
	)
	vim.api.nvim_win_set_buf(incoming_window, buffer)
	local lines = lines_of(incoming.text)
	vim.api.nvim_buf_set_lines(buffer, 0, -1, false, lines)
	vim.bo[buffer].filetype, vim.bo[buffer].bufhidden = "markdown", "wipe"
	vim.bo[buffer].modifiable = false
	vim.api.nvim_win_call(local_window, function()
		vim.cmd("diffthis")
	end)
	vim.cmd("diffthis")
	document.comparedRevision = incoming.revision
	vim.api.nvim_set_current_win(local_window)
	notify("Local edits left; incoming revision right. Merge locally, then :EditorResolve and :write")
end

function M.resolve()
	local document = require_document()
	if not document or not document.incoming then
		return
	end
	if document.save then
		notify("Reconcile the pending save with :write first", vim.log.levels.WARN)
		return
	end
	if document.comparedRevision ~= document.incoming.revision then
		notify("Inspect this incoming revision with :EditorCompare first", vim.log.levels.WARN)
		return
	end
	document.revision, document.text = document.incoming.revision, document.incoming.text
	document.writable, document.reason, document.title =
		document.incoming.writable, document.incoming.reason, document.incoming.title
	document.incoming, document.comparedRevision = nil, nil
	vim.bo[document.buffer].modified = true
	vim.bo[document.buffer].modifiable = true
	render(document)
	notify("Merged buffer is based on the incoming revision; :write saves it")
end

function M.reload(force)
	local document = require_document()
	if not document then
		return
	end
	if document.save then
		notify("Reconcile the pending save with :write first", vim.log.levels.WARN)
		return
	end
	if not force then
		notify("Use :EditorReload! to discard local edits, or :EditorCompare to merge", vim.log.levels.WARN)
		return
	end
	local snapshot = document.incoming
		or {
			title = document.title,
			ref = document.ref,
			revision = document.revision,
			text = document.text,
			writable = document.writable,
			reason = document.reason,
		}
	document.revision = nil
	apply_snapshot(document, snapshot, true)
end

function M.stop()
	comment_prompt.cancel()
	state.stopped, state.connected, state.syncing = true, false, false
	state.epoch = state.epoch + 1
	each_document(function(document)
		document.saving = false
	end)
	for request_id, stored in pairs(state.feedback) do
		local record = feedback_value(stored)
		if record.state ~= "answered" and record.state ~= "failed" then
			record.state, record.reason = "uncertain", "Disconnected before a confirmed terminal outcome"
			state.feedback[request_id] = record
		end
	end
	for window in pairs(state.windows) do
		restore_window(window)
	end
	if state.timer and not state.timer:is_closing() then
		state.timer:stop()
		state.timer:close()
	end
	if state.client then
		state.client:stop()
	end
end

function M.setup(connection)
	if not state.stopped then
		return
	end
	if not connection then
		local path = assert(vim.env.EDITOR_INTEROP_CONNECTION, "Editor connection manifest is missing")
		connection = wire.decode("ConnectionManifest", table.concat(vim.fn.readfile(path), "\n"))
	else
		connection = wire.validate("ConnectionManifest", connection)
	end
	if state.connection then
		assert(
			wire.same_session(state.connection.context.session, connection.context.session),
			"Reconnect cannot retarget existing documents to a different session"
		)
		assert(
			state.connection.projectionDirectory == connection.projectionDirectory,
			"Reconnect cannot change projection authority"
		)
	end
	assert(
		connection.version.major == 1 and connection.version.minor == 0,
		"Unsupported editor manifest protocol version"
	)
	state.connection, state.stopped, state.connected = connection, false, false
	local prior_client = state.client
	state.client = client_factory.new(connection)
	if prior_client then
		state.client.paths = prior_client.paths
	end
	state.group = state.group or vim.api.nvim_create_augroup("EditorDocuments", { clear = true })
	vim.api.nvim_set_hl(0, "EditorDocumentStatus", { link = "Comment", default = true })
	vim.api.nvim_set_hl(0, "EditorDocumentPending", { link = "DiagnosticWarn", default = true })
	vim.api.nvim_set_hl(0, "EditorDocumentAnswer", { link = "DiagnosticInfo", default = true })
	vim.api.nvim_create_user_command("EditorDocuments", function()
		vim.ui.select(document_list(), {
			prompt = "Editor documents",
			format_item = function(document)
				return document.title
					.. " · "
					.. vim.fn.fnamemodify(document.ref.session.projectId, ":t")
					.. " · "
					.. document.ref.ownerId:sub(1, 8)
					.. " · "
					.. status(document)
			end,
		}, function(document)
			if document then
				show_document(document)
			end
		end)
	end, {})
	vim.api.nvim_create_user_command("EditorComment", function(options)
		M.comment(options.line1, options.line2)
	end, { range = true })
	vim.api.nvim_create_user_command("EditorResponses", function()
		choose_feedback(function(feedback)
			if not feedback then
				return
			end
			notify(
				compact(
					(feedback.summary ~= "" and feedback.summary)
						or (feedback.reason ~= "" and feedback.reason)
						or feedback_labels[feedback.state]
						or feedback.state,
					300
				)
					.. "\nOriginal selection: "
					.. compact(feedback.selectedText, 140)
			)
		end)
	end, {})
	vim.api.nvim_create_user_command("EditorChanges", function()
		choose_feedback(show_changes)
	end, {})
	vim.api.nvim_create_user_command("EditorCompare", M.compare, {})
	vim.api.nvim_create_user_command("EditorResolve", M.resolve, {})
	vim.api.nvim_create_user_command("EditorReload", function(options)
		M.reload(options.bang)
	end, { bang = true })
	local lifecycle = vim.api.nvim_create_augroup("EditorInteropConnection", { clear = true })
	vim.api.nvim_create_autocmd("VimLeavePre", { group = lifecycle, callback = M.stop })
	vim.api.nvim_create_autocmd("WinClosed", {
		group = lifecycle,
		callback = function(event)
			state.windows[tonumber(event.match)] = nil
		end,
	})
	vim.api.nvim_create_user_command("EditorReconnect", function()
		M.stop()
		M.setup()
	end, {})
	state.client:register(function(_, err)
		if err then
			notify(err.message .. "; :EditorReconnect after the host is available", vim.log.levels.WARN)
			return
		end
		for _, window in ipairs(vim.api.nvim_list_wins()) do
			local buffer = vim.api.nvim_win_get_buf(window)
			if state.buffers[buffer] then
				vim.api.nvim_win_call(window, function()
					enter_document_window(buffer)
				end)
			end
		end
		state.timer = uv.new_timer()
		state.timer:start(0, 500, vim.schedule_wrap(M.sync))
	end)
end

M.inspect = function()
	return state
end
return M
