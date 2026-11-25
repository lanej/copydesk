-- Thin ProtoJSON edge. The descriptor table is generated from the frozen v1
-- schema; CEL equivalents below are checked by rule ID, never skipped.
local M = {}
local schemas
local number_mt, array_mt = {}, {}
local maximum_u64 = "18446744073709551615"

function M.utf8_length(value)
	local count, index = 0, 1
	while index <= #value do
		local byte = value:byte(index)
		local size, low, high = 1, 0x80, 0xbf
		if byte >= 0xc2 and byte <= 0xdf then
			size = 2
		elseif byte >= 0xe0 and byte <= 0xef then
			size = 3
			low, high = byte == 0xe0 and 0xa0 or low, byte == 0xed and 0x9f or high
		elseif byte >= 0xf0 and byte <= 0xf4 then
			size = 4
			low, high = byte == 0xf0 and 0x90 or low, byte == 0xf4 and 0x8f or high
		elseif byte >= 0x80 then
			error("Invalid UTF-8")
		end
		for offset = 1, size - 1 do
			local part = value:byte(index + offset)
			assert(
				part and part >= (offset == 1 and low or 0x80) and part <= (offset == 1 and high or 0xbf),
				"Invalid UTF-8"
			)
		end
		index, count = index + size, count + 1
	end
	return count
end

function M.compare(a, b)
	if #a ~= #b then
		return #a < #b and -1 or 1
	end
	return a == b and 0 or (a < b and -1 or 1)
end

function M.add(value, amount)
	local out, carry = {}, amount
	for index = #value, 1, -1 do
		local sum = tonumber(value:sub(index, index)) + carry
		table.insert(out, 1, tostring(sum % 10))
		carry = math.floor(sum / 10)
	end
	while carry > 0 do
		table.insert(out, 1, tostring(carry % 10))
		carry = math.floor(carry / 10)
	end
	local result = table.concat(out)
	assert(M.compare(result, maximum_u64) <= 0, "uint64 overflow")
	return result
end

local function integer(value)
	if type(value) == "table" and getmetatable(value) == number_mt then
		value = value.raw
	elseif type(value) == "number" then
		assert(value >= 0 and value <= 9007199254740991 and value == math.floor(value), "Inexact numeric integer")
		value = string.format("%.0f", value)
	end
	assert(type(value) == "string", "Expected integer")
	local base, exponent = value:match("^(.-)[eE]([+-]?%d+)$")
	base = base or value
	local negative = base:sub(1, 1) == "-"
	if negative or base:sub(1, 1) == "+" then
		base = base:sub(2)
	end
	local whole, fraction = base:match("^(%d+)%.(%d+)$")
	whole, fraction = whole or base, fraction or ""
	assert(whole:match("^%d+$"), "Invalid integer")
	local digits = (whole .. fraction):gsub("^0+", "")
	if digits == "" then
		return "0"
	end
	assert(not negative, "Negative unsigned integer")
	local shift = (exponent and tonumber(exponent) or 0) - #fraction
	assert(shift >= -#digits and shift <= 20, "Integer out of range")
	if shift < 0 then
		assert(digits:sub(#digits + shift + 1):match("^0+$"), "Fractional integer")
		digits = digits:sub(1, #digits + shift)
	else
		digits = digits .. string.rep("0", shift)
	end
	assert(M.compare(digits, maximum_u64) <= 0, "uint64 overflow")
	return digits
end

-- Preserve numeric lexemes until their declared field type is known. Passing a
-- JSON uint64 through Lua's double first would silently round valid revisions.
function M.parse(source)
	M.utf8_length(source)
	local at = 1
	local function space()
		local _, last = source:find("^[ \t\r\n]*", at)
		at = last + 1
	end
	local parse
	local function string_value()
		local first = at
		at = at + 1
		while at <= #source do
			local char = source:sub(at, at)
			if char == '"' then
				at = at + 1
				local result = vim.json.decode(source:sub(first, at - 1))
				M.utf8_length(result)
				return result
			end
			assert(source:byte(at) >= 32, "Unescaped JSON control character")
			at = at + (char == "\\" and 2 or 1)
		end
		error("Unterminated JSON string")
	end
	parse = function(depth)
		assert(depth <= 64, "JSON nesting limit exceeded")
		space()
		local char = source:sub(at, at)
		if char == '"' then
			return string_value()
		elseif char == "{" or char == "[" then
			local object = char == "{"
			local result = object and vim.empty_dict() or setmetatable({}, array_mt)
			local closing = object and "}" or "]"
			at = at + 1
			space()
			if source:sub(at, at) == closing then
				at = at + 1
				return result
			end
			while true do
				local key
				if object then
					assert(source:sub(at, at) == '"', "Expected JSON field name")
					key = string_value()
					assert(result[key] == nil, "Duplicate JSON field")
					space()
					assert(source:sub(at, at) == ":", "Expected JSON colon")
					at = at + 1
				end
				result[key or (#result + 1)] = parse(depth + 1)
				space()
				local next_char = source:sub(at, at)
				at = at + 1
				if next_char == closing then
					return result
				end
				assert(next_char == ",", "Expected JSON comma")
				space()
			end
		end
		for literal, value in pairs({ ["true"] = true, ["false"] = false, ["null"] = vim.NIL }) do
			if source:sub(at, at + #literal - 1) == literal then
				at = at + #literal
				return value
			end
		end
		local token = source:sub(at):match("^-?%d+%.?%d*[eE]?[+-]?%d*")
		assert(token, "Invalid JSON value")
		-- Neovim's decoder establishes JSON number grammar, while the original
		-- lexeme remains intact for exact unsigned conversion.
		assert(pcall(vim.json.decode, token), "Invalid JSON number")
		assert(not token:match("^-?0%d"), "Leading zero in JSON number")
		at = at + #token
		return setmetatable({ raw = token }, number_mt)
	end
	local result = parse(0)
	space()
	assert(at > #source, "Trailing JSON data")
	return result
end

local function base64(value)
	assert(type(value) == "string", "Expected base64 string")
	local normalized = value:gsub("%-", "+"):gsub("_", "/")
	assert(normalized:match("^[A-Za-z0-9+/]*=?=?$"), "Invalid base64")
	local bare = normalized:gsub("=+$", "")
	assert(#bare % 4 ~= 1, "Invalid base64 length")
	local padding = (4 - #bare % 4) % 4
	assert(#normalized == #bare or #normalized == #bare + padding, "Invalid base64 padding")
	local decoded = vim.base64.decode(bare .. string.rep("=", padding))
	assert(vim.base64.encode(decoded):gsub("=+$", "") == bare, "Invalid base64 trailing bits")
	return decoded
end

M.base64 = base64
M.integer = integer

local function load_schema()
	if not schemas then
		local path = vim.api.nvim_get_runtime_file("editor_interop_schema.json", false)[1]
		assert(path, "Editor protocol schema is missing")
		schemas = vim.json.decode(table.concat(vim.fn.readfile(path), "\n"))
	end
	return schemas
end

local rules = {}
rules["range.ordered"] = function(v)
	return v.endLine >= v.startLine
end
rules["feedback.failure_reason"] = function(v)
	return (
		v.state ~= "FEEDBACK_STATE_PARKED"
		and v.state ~= "FEEDBACK_STATE_FAILED"
		and v.state ~= "FEEDBACK_STATE_UNCERTAIN"
	) or #v.reason > 0
end
rules["feedback.answer_evidence"] = function(v)
	return v.state ~= "FEEDBACK_STATE_ANSWERED" or (#v.summary > 0 and #v.responseId > 0)
end
rules["chunk.bounds"] = function(v)
	local ending = M.add(v.offset, #v.data)
	return M.compare(ending, v.totalBytes) <= 0 and v.valueComplete == (ending == v.totalBytes)
end
rules["sync.item_kind"] = function(v)
	return not v.item or v.item.kind == "VALUE_KIND_DOCUMENT" or v.item.kind == "VALUE_KIND_FEEDBACK"
end
rules["sync.complete_cursor"] = function(v)
	return (v.complete ~= nil) == (v.nextCursor == "")
end
rules["save.result_page"] = function(v)
	return v.value.kind == "VALUE_KIND_SAVE_RESULT" and v.value.valueComplete == (v.nextCursor == "")
end
rules["feedback.result_page"] = function(v)
	return v.value.kind == "VALUE_KIND_FEEDBACK" and v.value.valueComplete == (v.nextCursor == "")
end
rules["result.kind"] = function(v)
	return v.value.kind == "VALUE_KIND_FEEDBACK" or v.value.kind == "VALUE_KIND_SAVE_RESULT"
end
rules["result.complete_cursor"] = function(v)
	return v.value.valueComplete == (v.nextCursor == "")
end

local function scalar(field, value)
	if field.kind == "enum" then
		if type(value) == "string" and field.values[value] ~= nil then
			return value
		end
		assert(type(value) ~= "string", "Unknown enum name")
		local number = integer(value)
		for name, candidate in pairs(field.values) do
			if tostring(candidate) == number then
				return name
			end
		end
		error("Unknown enum value")
	elseif field.scalar == 9 then
		assert(type(value) == "string", "Expected string")
		M.utf8_length(value)
		return value
	elseif field.scalar == 12 then
		return base64(value)
	elseif field.scalar == 8 then
		assert(type(value) == "boolean", "Expected boolean")
		return value
	elseif field.scalar == 4 then
		return integer(value)
	elseif field.scalar == 13 then
		local result = integer(value)
		assert(M.compare(result, "4294967295") <= 0, "uint32 overflow")
		return tonumber(result)
	end
	error("Unimplemented protobuf scalar")
end

function M.validate(name, value)
	local schema = assert(load_schema()[name], "Unknown protocol message")
	assert(
		type(value) == "table" and getmetatable(value) ~= array_mt and getmetatable(value) ~= number_mt,
		"Expected protocol object"
	)
	local known, result, choices = {}, vim.empty_dict(), {}
	for _, field in ipairs(schema.fields) do
		known[field.name], known[field.jsonName] = true, true
		local input = value[field.jsonName]
		if field.name ~= field.jsonName and value[field.name] ~= nil then
			assert(input == nil, "Repeated protobuf field alias")
			input = value[field.name]
		end
		if input == vim.NIL then
			input = nil
		end
		local present = input ~= nil
		assert(present or not field.rules.required, "Missing required " .. field.jsonName)
		if present and field.oneof then
			assert(not choices[field.oneof], "Multiple oneof values")
			choices[field.oneof] = true
		end
		if not present and (field.optional or field.oneof or field.kind == "message") then
			-- Message and optional presence remain meaningful; scalar defaults do not.
		else
			if not present then
				input = (field.kind == "list" and setmetatable({}, array_mt))
					or (field.kind == "enum" and 0)
					or (field.scalar == 8 and false)
					or ((field.scalar == 4 or field.scalar == 13) and 0)
					or ""
				if field.scalar == 8 then
					input = false
				end
			end
			local normalized
			if field.kind == "message" then
				normalized = M.validate(field.message, input)
			elseif field.kind == "list" then
				assert(
					type(input) == "table" and (getmetatable(input) == array_mt or vim.islist(input)),
					"Expected repeated field"
				)
				normalized = {}
				for _, element in ipairs(input) do
					assert(element ~= vim.NIL, "Null list element")
					table.insert(normalized, M.validate(field.message, element))
				end
			else
				normalized = scalar(field, input)
			end
			local constraints = field.rules.string or field.rules.bytes
			if constraints then
				local length = field.rules.bytes and #normalized or M.utf8_length(normalized)
				assert(not constraints.minLen or length >= tonumber(constraints.minLen), "Field is too short")
				assert(not constraints.maxLen or length <= tonumber(constraints.maxLen), "Field is too long")
				assert(not constraints.len or length == tonumber(constraints.len), "Wrong byte length")
				if constraints.pattern then
					assert(constraints.pattern == "^[a-f0-9]{64}$", "Unimplemented schema pattern")
					assert(#normalized == 64 and normalized:match("^[a-f0-9]+$"), "Invalid credential")
				end
			end
			constraints = field.rules.uint32 or field.rules.uint64
			if constraints then
				local decimal = integer(normalized)
				assert(constraints.gt == nil or M.compare(decimal, tostring(constraints.gt)) > 0, "Integer below bound")
				assert(constraints.const == nil or decimal == tostring(constraints.const), "Wrong protocol limit")
			end
			if field.rules.enum then
				for _, excluded in ipairs(field.rules.enum.notIn or {}) do
					assert(field.values[normalized] ~= excluded, "Prohibited enum default")
				end
			end
			result[field.jsonName] = normalized
		end
	end
	for field in pairs(value) do
		assert(known[field], "Unknown protocol field: " .. tostring(field))
	end
	for _, choice in ipairs(schema.oneofs) do
		assert(not choice.rules.required or choices[choice.name], "Missing required oneof")
	end
	for _, rule in ipairs(schema.rules.cel or {}) do
		assert(assert(rules[rule.id], "Unimplemented schema rule: " .. rule.id)(result), rule.message)
	end
	return result
end

function M.decode(name, source)
	return M.validate(name, M.parse(source))
end

function M.encode(name, value)
	local normalized = M.validate(name, value)
	local function bytes(type_name, object)
		for _, field in ipairs(load_schema()[type_name].fields) do
			local item = object[field.jsonName]
			if item ~= nil then
				if field.scalar == 12 then
					object[field.jsonName] = vim.base64.encode(item)
				elseif field.kind == "message" then
					bytes(field.message, item)
				elseif field.kind == "list" then
					for _, element in ipairs(item) do
						bytes(field.message, element)
					end
				end
			end
		end
	end
	bytes(name, normalized)
	return vim.json.encode(normalized)
end

function M.key(ref)
	return vim.json.encode({
		ref.session.providerId,
		ref.session.projectId,
		ref.session.conversationId,
		ref.ownerId,
		ref.documentId,
	})
end

function M.same_session(a, b)
	return a.providerId == b.providerId and a.projectId == b.projectId and a.conversationId == b.conversationId
end

return M
