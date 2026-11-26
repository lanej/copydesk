local root = assert(vim.env.COPYDESK_RUNTIME)
vim.opt.runtimepath:append(root)
local wire = require("copydesk_wire")
local uv = vim.uv
local function read(path)
	return table.concat(vim.fn.readfile(path), "\n")
end
local fixtures = assert(vim.env.COPYDESK_FIXTURES)
local checked = 0
local function check(value, message)
	assert(value, message)
	checked = checked + 1
end
local function fixture(name)
	return vim.json.decode(read(fixtures .. "/" .. name .. ".json"))
end
for _, name in ipairs({ "register", "sync", "save", "feedback" }) do
	local data = fixture(name)
	for _, call in ipairs(data.calls or { data }) do
		wire.decode(call.requestType, vim.json.encode(call.request))
		wire.decode(call.responseType, vim.json.encode(call.response))
		checked = checked + 2
	end
end
for _, case in ipairs(fixture("invalid-values").cases) do
	check(
		pcall(wire.decode, case.type, vim.json.encode(case.value)) == case.valid,
		"Golden validation differs: " .. case.type
	)
end
check(wire.decode("ProtocolVersion", '{"major":1}').minor == 0, "Omitted scalar default")
check(wire.decode("SyncComplete", "{}").documentCount == "0", "Omitted uint64 default")
check(
	wire.decode("SyncComplete", '{"documentCount":18446744073709551615}').documentCount == "18446744073709551615",
	"Exact unquoted uint64"
)
check(
	wire.decode("SyncComplete", '{"document_count":"9.007199254740993e15"}').documentCount == "9007199254740993",
	"Exact exponent and proto field name"
)
check(not pcall(wire.decode, "SyncComplete", '{"documentCount":"18446744073709551616"}'), "uint64 overflow rejected")
check(not pcall(wire.decode, "SyncComplete", '{"documentCount":1,"document_count":1}'), "Duplicate alias rejected")
check(not pcall(wire.decode, "ProtocolVersion", '{"major":1,"unknown":true}'), "Unknown field rejected")
check(not pcall(wire.decode, "ProtocolVersion", '{"major":1.5}'), "Fractional integer rejected")
local command = fixture("feedback").request.command
local record = fixture("sync").expectedFeedback[1]
record.state = 5
check(
	wire.decode("FeedbackRecord", vim.json.encode(record)).state == "FEEDBACK_STATE_ANSWERED",
	"Numeric known enum accepted"
)
record.state = "99"
check(not pcall(wire.decode, "FeedbackRecord", vim.json.encode(record)), "Unknown enum string rejected")
check(
	wire.decode("SyncHeader", vim.json.encode({ session = command.ref.session })).activeOwnerId == nil,
	"Optional absence preserved"
)
check(
	not pcall(wire.decode, "SyncHeader", vim.json.encode({ session = command.ref.session, activeOwnerId = "" })),
	"Present empty owner rejected"
)
check(wire.base64("_w") == string.char(255), "Unpadded URL-safe base64")
check(not pcall(wire.base64, "/x=="), "Noncanonical trailing bits rejected")
check(not pcall(wire.decode, "ProtocolVersion", '{"major":1} trailing'), "Trailing JSON rejected")
local save = fixture("save").calls[1].request.command
save.text = string.rep("🦉", 2000000)
check(pcall(wire.validate, "SaveCommand", save), "Unicode scalar save bound accepted")
save.text = save.text .. "🦉"
check(not pcall(wire.validate, "SaveCommand", save), "Unicode scalar save overflow rejected")
save = nil
collectgarbage("collect")

local directory = vim.fn.tempname() .. "-wire"
assert(uv.fs_mkdir(directory, 448))
local projection = directory .. "/document.md"
vim.fn.writefile({ "# Draft" }, projection)
local manifest = wire.decode("ConnectionManifest", vim.json.encode(fixture("manifest")))
manifest.projectionDirectory = assert(uv.fs_realpath(directory))
local session = manifest.context.session
local view = fixture("sync").expectedDocuments[1]
view.projectionPath = manifest.projectionDirectory .. "/document.md"
-- Exercise the real Unix HTTP parser with fragmented headers, both framing
-- forms, and malformed replies. The fake server owns only this test socket.
local http = require("copydesk_http")
local socket_path = directory .. "/http.sock"
local server = uv.new_pipe(false)
assert(server:bind(socket_path))
local response_bytes
local response_body = vim.json.encode(fixture("register").response)
local request_checks = 0
server:listen(8, function()
	local peer = uv.new_pipe(false)
	assert(server:accept(peer))
	local input = ""
	peer:read_start(function(err, bytes)
		assert(not err)
		if not bytes then
			if not peer:is_closing() then
				peer:close()
			end
			return
		end
		input = input .. bytes
		local ending = input:find("\r\n\r\n", 1, true)
		if not ending then
			return
		end
		local length = tonumber(input:match("Content%-Length: (%d+)"))
		if #input < ending + 3 + length then
			return
		end
		peer:read_stop()
		assert(input:find("POST /editorinterop.v1.EditorInteropService/Register HTTP/1.1", 1, true))
		assert(input:find("Authorization: Bearer " .. manifest.bearerToken, 1, true))
		request_checks = request_checks + 1
		local packet, position = response_bytes, 1
		local timer = uv.new_timer()
		timer:start(0, 1, function()
			local part = packet:sub(position, position + 36)
			position = position + #part
			peer:write(part)
			if position > #packet then
				timer:stop()
				timer:close()
				peer:shutdown(function()
					if not peer:is_closing() then
						peer:close()
					end
				end)
			end
		end)
	end)
end)
manifest.socketPath = socket_path
local register_request = fixture("register").request
local function http_case(packet, expected)
	response_bytes = packet
	local finished, result, failure = false
	http.call(manifest, "Register", register_request, function(value, err)
		finished, result, failure = true, value, err
	end)
	check(
		vim.wait(8000, function()
			return finished
		end, 5),
		"HTTP response finished"
	)
	if expected == "ok" then
		check(result and result.selectedVersion.major == 1, failure and failure.message or "HTTP result")
	else
		check(failure and failure.code == expected, failure and failure.message or "Unexpected HTTP success")
	end
end
http_case(
	"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: "
		.. #response_body
		.. "\r\n\r\n"
		.. response_body,
	"ok"
)
local chunked = ""
for start = 1, #response_body, 11 do
	local piece = response_body:sub(start, start + 10)
	chunked = chunked .. string.format("%x;fixture=yes\r\n", #piece) .. piece .. "\r\n"
end
http_case(
	"HTTP/1.1 200 OK\r\nContent-Type: application/json; charset=utf-8\r\nTransfer-Encoding: chunked\r\n\r\n"
		.. chunked
		.. "0\r\nFixture-Trailer: yes\r\n\r\n",
	"ok"
)
local failure = [[{"code":"unauthenticated","message":"Wrong bearer"}]]
http_case(
	"HTTP/1.1 401 Unauthorized\r\nContent-Type: application/json\r\nContent-Length: "
		.. #failure
		.. "\r\n\r\n"
		.. failure,
	"unauthenticated"
)
http_case("HTTP/1.1 200 OK\r\nContent-Type: application/jsonx\r\nContent-Length: 2\r\n\r\n{}", "protocol")
http_case(
	"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 2\r\nTransfer-Encoding: chunked\r\n\r\n{}",
	"protocol"
)
http_case("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 65537\r\n\r\n", "protocol")
http_case("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 100\r\n\r\n{}", "protocol")
check(request_checks == 7, "All HTTP tests sent real authenticated unary requests")
server:close()
uv.fs_unlink(socket_path)
local pages, at = {}, 0
package.loaded.copydesk_http = {
	call = function(_, method, _, callback)
		check(method == "Sync", "Only read requests in staging fixture")
		at = at + 1
		local page = pages[at]
		vim.schedule(function()
			if not page then
				callback(nil, { code = "uncertain", message = "Truncated snapshot" })
				return
			end
			local ok, value = pcall(wire.decode, "SyncResponse", vim.json.encode(page))
			if ok then
				callback(value)
			else
				callback(nil, { code = "protocol", message = value })
			end
		end)
		return function() end
	end,
}
local client = require("copydesk_client").new(manifest)
client.registered = true
local function digest(raw)
	return vim.base64.encode((vim.fn.sha256(raw):gsub("..", function(pair)
		return string.char(tonumber(pair, 16))
	end)))
end
local function build(raw)
	local list = {
		{
			snapshotId = "snapshot",
			sequence = "1",
			header = { session = session, activeOwnerId = "owner-one" },
			nextCursor = "cursor-1",
		},
	}
	local hash, offset = digest(raw), 0
	while offset < #raw do
		-- The first boundary splits the owl's UTF-8 bytes; later ones use the cap.
		local length = offset == 0 and (raw:find("🦉", 1, true) or 11) or 32768
		local data = raw:sub(offset + 1, offset + length)
		list[#list + 1] = {
			snapshotId = "snapshot",
			sequence = tostring(#list + 1),
			nextCursor = "cursor-" .. (#list + 1),
			item = {
				transferId = "value",
				kind = "VALUE_KIND_DOCUMENT",
				totalBytes = tostring(#raw),
				sha256 = hash,
				offset = tostring(offset),
				data = vim.base64.encode(data),
				valueComplete = offset + #data == #raw,
			},
		}
		offset = offset + #data
	end
	list[#list + 1] = { snapshotId = "snapshot", sequence = tostring(#list + 1), complete = { documentCount = "1" } }
	return list
end
local function sync(candidate, valid)
	pages, at = candidate, 0
	local finished, result, failure = false
	client:sync(function(value, err)
		finished, result, failure = true, value, err
	end)
	check(
		vim.wait(120000, function()
			return finished
		end, 5),
		"Staged sync completes or fails boundedly"
	)
	check((result ~= nil) == valid, failure and failure.message or "Unexpected snapshot success")
	check(next(client.stages) == nil, "No partial staging remains")
	return result
end
local raw = vim.json.encode(view)
local complete = sync(build(raw), true)
check(complete.documents[1].document.text == view.document.text, "Split UTF-8 reconstructs exact text")
local broken = build(raw)
broken[2].item.sha256 = vim.base64.encode(string.rep("\0", 32))
sync(broken, false)
broken = build(raw)
broken[3].sequence = "4"
sync(broken, false)
broken = build(raw)
table.remove(broken)
sync(broken, false)
broken = build(raw)
broken[#broken].complete.documentCount = "2"
sync(broken, false)
broken = build(raw)
broken[3].item.offset = "0"
sync(broken, false)
local escape = vim.deepcopy(view)
escape.projectionPath = directory .. "/../outside.md"
sync(build(vim.json.encode(escape)), false)
check(
	client.paths[wire.key(view.document.ref)] == view.projectionPath,
	"Failed snapshots preserve established membership"
)
local vector = fixture("size-vectors").vectors[1]
view.document.text = string.rep(vector.unit, vector["repeat"])
raw = vim.json.encode(view)
check(#raw > 33554432, "Large read really exceeds unary request limit")
complete = sync(build(raw), true)
check(
	complete.documents[1].document.text == view.document.text,
	"Unbounded read reconstructs exact escaped Unicode and NUL text"
)
client:stop()
vim.fn.delete(client.directory, "rf")
vim.fn.delete(directory, "rf")
print(vim.json.encode({ status = "passed", checks = checked, largeValueBytes = #raw }))
vim.cmd("qa!")
