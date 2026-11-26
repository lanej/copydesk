local M = {}
local uv = vim.uv
local wire = require("copydesk_wire")
local http = require("copydesk_http")
local editor_instance_id = tostring(vim.fn.getpid()) .. "-" .. tostring(uv.hrtime())
local function read(path)
	local file = assert(io.open(path, "rb"))
	local value = file:read("*a")
	file:close()
	return value
end
local function hex(bytes)
	return (bytes:gsub(".", function(c)
		return string.format("%02x", c:byte())
	end))
end
local function fail(message)
	return { code = "protocol", message = tostring(message) }
end

-- A transfer is staged as bytes, never as independently decoded UTF-8 chunks.
-- Keeping historical receipts on disk avoids a second unbounded in-memory copy.
function M.new(manifest)
	local self =
		{ manifest = manifest, pending = {}, paths = {}, receipts = {}, stopped = false, serial = 0, stages = {} }
	self.directory = vim.fn.tempname() .. "-editor-interop"
	assert(uv.fs_mkdir(self.directory, 448))
	local root = assert(uv.fs_realpath(manifest.projectionDirectory), "Projection directory does not exist")
	assert(
		root == manifest.projectionDirectory and root:sub(1, 1) == "/",
		"Projection directory must be canonical and absolute"
	)
	local stat = assert(uv.fs_stat(root))
	assert(
		stat.type == "directory" and bit.band(stat.mode, 63) == 0 and stat.uid == uv.getuid(),
		"Projection directory is not privately owned"
	)
	self.root = root
	self.editor_id = editor_instance_id
	function self:file()
		self.serial = self.serial + 1
		return self.directory .. "/" .. self.serial .. ".json"
	end
	function self:call(method, params, callback)
		if self.stopped then
			callback(nil, { code = "cancelled", message = "Editor connection closed" })
			return
		end
		self.serial = self.serial + 1
		local serial = self.serial
		self.pending[serial] = http.call(self.manifest, method, params, function(value, err)
			self.pending[serial] = nil
			if not self.stopped then
				callback(value, err)
			end
		end)
	end
	function self:register(callback)
		local rpc = vim.v.servername
		if rpc == "" then
			rpc = vim.fn.serverstart(self.directory .. "/rpc.sock")
		end
		self:call("Register", {
			context = self.manifest.context,
			version = { major = 1, minor = 0 },
			editor = {
				editorInstanceId = self.editor_id,
				processId = vim.fn.getpid(),
				rpcAddress = rpc,
				launchId = self.manifest.launchId,
			},
		}, function(value, err)
			if value then
				if
					not vim.deep_equal(value.context, self.manifest.context)
					or value.selectedVersion.major ~= 1
					or value.selectedVersion.minor ~= 0
				then
					callback(nil, fail("Registration bound a different session or protocol"))
					return
				end
				self.registered = true
			end
			callback(value, err)
		end)
	end
	function self:stage()
		local stage = { files = {}, used = {} }
		self.stages[stage] = true
		function stage:cleanup()
			if self.current and self.current.fd then
				uv.fs_close(self.current.fd)
				self.current.fd = nil
			end
			for _, path in ipairs(self.files) do
				uv.fs_unlink(path)
			end
			self.files = {}
			self.owner.stages[self] = nil
		end
		function stage:chunk(chunk)
			local current = self.current
			if not current then
				assert(chunk.offset == "0" and not self.used[chunk.transferId], "Repeated or noninitial transfer")
				self.used[chunk.transferId] = true
				local path = self.owner:file()
				current = {
					transferId = chunk.transferId,
					kind = chunk.kind,
					totalBytes = chunk.totalBytes,
					sha256 = chunk.sha256,
					offset = "0",
					path = path,
					fd = assert(uv.fs_open(path, "wx", 384)),
				}
				table.insert(self.files, path)
				self.current = current
			end
			assert(
				chunk.transferId == current.transferId
					and chunk.kind == current.kind
					and chunk.totalBytes == current.totalBytes
					and chunk.sha256 == current.sha256
					and chunk.offset == current.offset,
				"Inconsistent or interleaved value transfer"
			)
			local at = 1
			while at <= #chunk.data do
				local written = assert(uv.fs_write(current.fd, chunk.data:sub(at), -1))
				assert(written > 0, "Incomplete staging write")
				at = at + written
			end
			current.offset = wire.add(current.offset, #chunk.data)
			if not chunk.valueComplete then
				return
			end
			assert(current.offset == current.totalBytes, "Incomplete value")
			uv.fs_close(current.fd)
			current.fd = nil
			local raw = read(current.path)
			assert(vim.fn.sha256(raw) == hex(current.sha256), "Value digest mismatch")
			local types = {
				VALUE_KIND_DOCUMENT = "DocumentView",
				VALUE_KIND_FEEDBACK = "FeedbackRecord",
				VALUE_KIND_SAVE_RESULT = "SaveResult",
			}
			local value = wire.decode(assert(types[current.kind]), raw)
			self.current = nil
			return value, current.path
		end
		stage.owner = self
		return stage
	end
	function self:check_ref(ref)
		assert(wire.same_session(ref.session, self.manifest.context.session), "Document session changed")
	end
	function self:check_view(view, paths)
		self:check_ref(view.document.ref)
		local path, document_key = view.projectionPath, wire.key(view.document.ref)
		assert(
			path:sub(1, #self.root + 1) == self.root .. "/" and uv.fs_realpath(path) == path,
			"Projection path escaped its private directory"
		)
		assert(uv.fs_stat(path).type == "file", "Projection is not a regular file")
		assert(not paths[path], "Repeated projection path")
		paths[path] = document_key
		assert(not self.paths[document_key] or self.paths[document_key] == path, "Document projection path changed")
	end
	function self:sync(callback)
		if not self.registered then
			callback(nil, { code = "failed_precondition", message = "Editor is not registered" })
			return
		end
		local stage, sequence, snapshot_id, header = self:stage(), "1", nil, nil
		local documents, feedback, seen, paths = {}, {}, {}, {}
		local counts = { documentCount = "0", feedbackCount = "0" }
		local function done(value, err)
			if not value then
				stage:cleanup()
			end
			callback(value, err)
		end
		local next_page
		next_page = function(cursor, retry)
			self:call("Sync", { context = self.manifest.context, cursor = cursor }, function(page, err)
				if err then
					-- Only a cursor read is replayable. Starting again could supersede a
					-- still live snapshot; mutating calls are never retried here.
					if cursor ~= "" and err.code == "uncertain" and not retry then
						next_page(cursor, true)
						return
					end
					done(nil, err)
					return
				end
				local ok, failure = pcall(function()
					assert(page.sequence == sequence, "Snapshot sequence is not contiguous")
					snapshot_id = snapshot_id or page.snapshotId
					assert(page.snapshotId == snapshot_id, "Snapshot identity changed")
					sequence = wire.add(sequence, 1)
					if page.header then
						assert(not header and page.sequence == "1", "Snapshot header must be first")
						assert(
							wire.same_session(page.header.session, self.manifest.context.session),
							"Snapshot session changed"
						)
						header = page.header
					elseif page.item then
						assert(header, "Snapshot has no header")
						local value, path = stage:chunk(page.item)
						if value then
							if page.item.kind == "VALUE_KIND_DOCUMENT" then
								self:check_view(value, paths)
								assert(
									value.document.ref.ownerId == header.activeOwnerId,
									"Snapshot document has an inactive owner"
								)
								local document_key = wire.key(value.document.ref)
								assert(not seen[document_key], "Repeated snapshot document")
								seen[document_key] = true
								table.insert(
									documents,
									{ path = path, key = document_key, projectionPath = value.projectionPath }
								)
								counts.documentCount = wire.add(counts.documentCount, 1)
							else
								self:check_ref(value.request.ref)
								local request_id = value.request.requestId
								assert(not feedback[request_id], "Repeated snapshot feedback")
								feedback[request_id] = path
								counts.feedbackCount = wire.add(counts.feedbackCount, 1)
							end
						end
					else
						assert(
							header and not stage.current and vim.deep_equal(counts, page.complete),
							"Snapshot ended before validated membership"
						)
					end
				end)
				if not ok then
					done(nil, fail(failure))
					return
				end
				if not page.complete then
					next_page(page.nextCursor)
					return
				end
				-- Publish only after the final digest/count validated page. Earlier
				-- failures cannot detach a buffer or erase a terminal receipt.
				for _, entry in ipairs(documents) do
					self.paths[entry.key] = entry.projectionPath
				end
				for request_id, path in pairs(feedback) do
					local target = self.receipts[request_id]
						or (self.directory .. "/receipt-" .. vim.fn.sha256(request_id) .. ".json")
					local prior = self.receipts[request_id] and self:read_receipt(target)
					local next_value = self:read_receipt(path)
					local terminal = prior
						and (prior.state == "FEEDBACK_STATE_ANSWERED" or prior.state == "FEEDBACK_STATE_FAILED")
					if not terminal or next_value.state == prior.state then
						assert(uv.fs_rename(path, target))
					end
					self.receipts[request_id], feedback[request_id] = target, target
				end
				local views = {}
				for _, entry in ipairs(documents) do
					table.insert(views, wire.decode("DocumentView", read(entry.path)))
				end
				for _, path in ipairs(stage.files) do
					uv.fs_unlink(path)
				end
				stage.files = {}
				self.stages[stage] = nil
				done({ documents = views, feedback = feedback, header = header })
			end)
		end
		next_page("")
	end
	function self:operation(method, command, callback)
		local stage = self:stage()
		local retrieving = false
		local function done(value, err)
			stage:cleanup()
			callback(value, err)
		end
		local consume
		consume = function(page, err)
			if err then
				if retrieving then
					err = { code = "uncertain", message = "Outcome retrieval interrupted: " .. err.message }
				end
				done(nil, err)
				return
			end
			local ok, value = pcall(function()
				assert(
					page.value.kind == (method == "Save" and "VALUE_KIND_SAVE_RESULT" or "VALUE_KIND_FEEDBACK"),
					"Operation returned the wrong value kind"
				)
				local result = stage:chunk(page.value)
				if result then
					if method == "Save" then
						local receipt = result.accepted or result.rejected or result.uncertain
						assert(receipt.operationId == command.operationId, "Save receipt identity changed")
						if result.accepted then
							assert(
								wire.key(result.accepted.document.ref) == wire.key(command.ref),
								"Accepted save changed document identity"
							)
						end
						if result.rejected and result.rejected.current then
							assert(
								wire.key(result.rejected.current.ref) == wire.key(command.ref),
								"Rejected save changed document identity"
							)
						end
					else
						assert(vim.deep_equal(result.request, command), "Feedback receipt changed the exact request")
					end
				end
				return result
			end)
			if not ok then
				done(nil, fail(value))
				return
			end
			if value then
				done(value)
				return
			end
			retrieving = true
			local cursor = page.nextCursor
			self:call("Result", { context = self.manifest.context, cursor = cursor }, function(result, failure)
				if failure and failure.code == "uncertain" then
					self:call("Result", { context = self.manifest.context, cursor = cursor }, consume)
				else
					consume(result, failure)
				end
			end)
		end
		self:call(method, { context = self.manifest.context, command = command }, consume)
	end
	function self:read_receipt(path)
		return wire.decode("FeedbackRecord", read(path))
	end
	function self:stop()
		self.stopped = true
		for _, cancel in pairs(self.pending) do
			cancel()
		end
		self.pending = {}
		for stage in pairs(self.stages) do
			stage:cleanup()
		end
		-- Receipt files remain available to buffers after disconnect/reconnect.
	end
	return self
end
return M
