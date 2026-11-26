local M = {}

local actions = {
	{ "comment", "c", "Comment on the current line or selection" },
	{ "documents", "s", "Choose a Copydesk document" },
	{ "responses", "r", "Inspect Copydesk responses" },
	{ "changes", "d", "Jump to Copydesk changes" },
	{ "compare", "v", "Compare Copydesk revisions" },
	{ "resolve", "m", "Adopt the incoming Copydesk revision" },
	{ "reload", "l", "Reload the Copydesk document" },
	{ "reconnect", "x", "Reconnect Copydesk" },
}

function M.resolve(overrides)
	local mappings = {}
	if overrides == false then
		return mappings
	end
	vim.validate("keymaps", overrides, "table", true)
	for _, action in ipairs(actions) do
		mappings[action[1]] = "<localleader>s" .. action[2]
	end
	for action, mapping in pairs(overrides or {}) do
		assert(mappings[action] ~= nil, "Unknown Copydesk keymap: " .. tostring(action))
		assert(mapping == false or (type(mapping) == "string" and mapping ~= ""), "Invalid Copydesk keymap: " .. action)
		mappings[action] = mapping
	end
	return mappings
end

function M.bind(buffer, copydesk, mappings)
	for _, action in ipairs(actions) do
		local name, _, description = unpack(action)
		local mapping = mappings[name]
		if mapping then
			local callback = copydesk[name]
			if name == "reload" then
				callback = function()
					if
						vim.fn.confirm("Reload the Copydesk document and discard local edits?", "&Cancel\n&Reload", 1)
						== 2
					then
						copydesk.reload(true)
					end
				end
			end
			local opts = { buffer = buffer, desc = description }
			vim.keymap.set("n", mapping, callback, opts)
			if name == "comment" then
				vim.keymap.set("x", mapping, copydesk.comment_selection, opts)
			end
		end
	end
end

return M
