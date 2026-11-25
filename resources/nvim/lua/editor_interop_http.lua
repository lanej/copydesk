local M = {}
local uv = vim.uv or vim.loop
local wire = require("editor_interop_wire")
local body_limit, header_limit = 65536, 16384

-- One connection per unary call. Identity belongs to the bearer registration,
-- not to this short-lived socket. No transport failure proves rollback.
function M.call(connection, method, request, callback)
	local ok, body = pcall(wire.encode, method .. "Request", request)
	if not ok or #body > 33554432 then
		vim.schedule(function()
			callback(
				nil,
				{ code = "invalid_argument", message = ok and "Request exceeds the encoded byte limit" or body }
			)
		end)
		return function() end
	end
	local pipe, timer = uv.new_pipe(false), uv.new_timer()
	local finished, incoming, status, headers = false, "", nil, nil
	local pieces, size, remaining, chunk_size, trailer = {}, 0, nil, nil, false
	local function finish(result, err)
		if finished then
			return
		end
		finished = true
		timer:stop()
		timer:close()
		if not pipe:is_closing() then
			pipe:read_stop()
			pipe:close()
		end
		vim.schedule(function()
			callback(result, err)
		end)
	end
	local function uncertain(message)
		finish(nil, { code = "uncertain", message = message })
	end
	local function append(value)
		size = size + #value
		assert(size <= body_limit, "Response exceeds the encoded byte limit")
		table.insert(pieces, value)
	end
	local function complete()
		assert(
			headers["content-type"]
				and (
					headers["content-type"]:lower() == "application/json"
					or headers["content-type"]:lower():match("^application/json%s*;")
				),
			"Expected Connect JSON response"
		)
		assert(
			not headers["content-encoding"] or headers["content-encoding"] == "identity",
			"Compressed response is not supported"
		)
		local value = table.concat(pieces)
		if status == 200 then
			finish(wire.decode(method .. "Response", value))
		else
			local failure = wire.parse(value)
			assert(type(failure) == "table" and type(failure.code) == "string", "Invalid Connect error")
			assert(failure.message == nil or type(failure.message) == "string", "Invalid Connect error message")
			finish(nil, { code = failure.code, message = failure.message or failure.code })
		end
	end
	local function consume(eof)
		if not headers then
			local boundary = incoming:find("\r\n\r\n", 1, true)
			assert((boundary or #incoming) <= header_limit, "HTTP header limit exceeded")
			if not boundary then
				assert(not eof, "Incomplete HTTP response")
				return
			end
			local head = incoming:sub(1, boundary - 1)
			incoming = incoming:sub(boundary + 4)
			local first, rest = head:match("^([^\r\n]+)\r\n(.*)$")
			first, rest = first or head, rest or ""
			status = tonumber(first:match("^HTTP/1%.[01] (%d%d%d) .*$"))
			assert(status, "Invalid HTTP status")
			headers = {}
			for line in (rest .. "\r\n"):gmatch("([^\r\n]+)\r\n") do
				local name, value = line:match("^([!#$%%&'*+.^_`|~%w-]+):%s*(.-)%s*$")
				assert(name, "Invalid HTTP header")
				name = name:lower()
				assert(not headers[name], "Duplicate HTTP header")
				headers[name] = value
			end
			assert(not (headers["content-length"] and headers["transfer-encoding"]), "Ambiguous HTTP framing")
			if headers["content-length"] then
				assert(headers["content-length"]:match("^%d+$"), "Invalid HTTP content length")
				remaining = tonumber(headers["content-length"])
				assert(remaining <= body_limit, "Response exceeds the encoded byte limit")
			end
			assert(
				not headers["transfer-encoding"] or headers["transfer-encoding"]:lower() == "chunked",
				"Unsupported transfer coding"
			)
		end
		if headers["transfer-encoding"] then
			while not finished do
				if trailer then
					if incoming:sub(1, 2) == "\r\n" then
						complete()
						return
					end
					local ending = incoming:find("\r\n\r\n", 1, true)
					assert((ending or #incoming) <= header_limit, "HTTP trailer limit exceeded")
					if ending then
						complete()
						return
					end
					assert(not eof, "Incomplete HTTP trailers")
					return
				end
				if chunk_size == nil then
					local ending = incoming:find("\r\n", 1, true)
					assert((ending or #incoming) <= 1024, "Invalid HTTP chunk header")
					if not ending then
						assert(not eof, "Incomplete HTTP chunk")
						return
					end
					local line = incoming:sub(1, ending - 1)
					local hex = line:match("^([a-fA-F0-9]+)$") or line:match("^([a-fA-F0-9]+);[^\r\n]*$")
					assert(hex and #hex <= 16, "Invalid HTTP chunk size")
					chunk_size = tonumber(hex, 16)
					assert(chunk_size <= body_limit - size, "Response exceeds the encoded byte limit")
					incoming = incoming:sub(ending + 2)
					if chunk_size == 0 then
						trailer = true
					end
				end
				if not trailer then
					if #incoming < chunk_size + 2 then
						assert(not eof, "Incomplete HTTP chunk")
						return
					end
					assert(incoming:sub(chunk_size + 1, chunk_size + 2) == "\r\n", "Invalid HTTP chunk terminator")
					append(incoming:sub(1, chunk_size))
					incoming = incoming:sub(chunk_size + 3)
					chunk_size = nil
				end
			end
		elseif remaining then
			assert(#incoming <= remaining, "Excess HTTP response bytes")
			append(incoming)
			remaining = remaining - #incoming
			incoming = ""
			if remaining == 0 then
				complete()
			else
				assert(not eof, "Incomplete HTTP body")
			end
		else
			append(incoming)
			incoming = ""
			if eof then
				complete()
			end
		end
	end
	timer:start(5000, 0, function()
		uncertain("No acknowledgment; the operation may have been accepted")
	end)
	pipe:connect(connection.socketPath, function(connect_error)
		if finished then
			return
		end
		if connect_error then
			uncertain("Cannot reach the bound host session")
			return
		end
		pipe:read_start(function(read_error, chunk)
			if finished then
				return
			end
			if read_error then
				uncertain("Connection failed before acknowledgment")
				return
			end
			incoming = incoming .. (chunk or "")
			local valid, failure = pcall(consume, chunk == nil)
			if not valid then
				finish(nil, { code = "protocol", message = failure })
			end
		end)
		local packet = table.concat({
			"POST /editorinterop.v1.EditorInteropService/" .. method .. " HTTP/1.1",
			"Host: localhost",
			"Content-Type: application/json",
			"Connect-Protocol-Version: 1",
			"Authorization: Bearer " .. connection.bearerToken,
			"Content-Length: " .. tostring(#body),
			"Connection: close",
			"",
			body,
		}, "\r\n")
		pipe:write(packet, function(write_error)
			if write_error then
				uncertain("Write failed before acknowledgment")
			end
		end)
	end)
	return function()
		finish(nil, { code = "cancelled", message = "Document connection closed" })
	end
end

return M
