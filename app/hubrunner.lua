--[[ HubRunner (Flux Control)
  Lets Flux Control, and its AI mode, reach this game. Run it once, or put it in your autoexec.
  Files in <workspace>/HubRunner:
    run.lua, run.id   code sent from Flux Control (run.id changes each time)
    alive.txt         heartbeat, so Flux Control can show "Connected"
    status.json       result of the last run (ok, error, return value, print output)
  The `flux` table below holds the helpers the AI tools call: info, tree, search, source, console, click, type, spy.
]]
local DIR = "HubRunner"
local Http = game:GetService("HttpService")
local LogService = game:GetService("LogService")
local G = getgenv and getgenv() or _G

if G.__HubRunner then G.__HubRunner.stop = true end -- a newer copy replaces the old one
local state = { stop = false }
G.__HubRunner = state

if not isfolder(DIR) then makefolder(DIR) end

local function read(name)
	local ok, data = pcall(readfile, DIR .. "/" .. name)
	if ok then return data end
end
local function write(name, data)
	pcall(writefile, DIR .. "/" .. name, data)
end

-- ---------------------------------------------------------------- helpers for the AI tools
local flux = {}

local function short(v)
	local t = typeof(v)
	if t == "string" then return string.format("%q", string.sub(v, 1, 80)) end
	if t == "Instance" then
		local ok, n = pcall(v.GetFullName, v)
		return ok and n or "Instance"
	end
	if t == "table" then
		local n = 0
		for _ in pairs(v) do n = n + 1 end
		return "{table, " .. n .. " keys}"
	end
	return tostring(v)
end

-- "game.Workspace.Map.Door" or "Workspace.Map.Door" -> Instance (names that contain dots are not supported)
function flux.find(path)
	if typeof(path) == "Instance" then return path end
	local cur = game
	for seg in string.gmatch(tostring(path or "game"), "[^%.]+") do
		if not (cur == game and seg == "game") then
			local nxt = cur:FindFirstChild(seg)
			if not nxt and cur == game then
				local ok, s = pcall(game.GetService, game, seg)
				if ok then nxt = s end
			end
			if not nxt then error("not found: " .. seg .. " in " .. (cur == game and "game" or cur:GetFullName()), 0) end
			cur = nxt
		end
	end
	return cur
end

function flux.info()
	local P = game:GetService("Players")
	local lp = P.LocalPlayer
	local name = "?"
	pcall(function() name = game:GetService("MarketplaceService"):GetProductInfo(game.PlaceId).Name end)
	local lines = {
		"Place: " .. name .. " (PlaceId " .. game.PlaceId .. ", GameId " .. game.GameId .. ", version " .. game.PlaceVersion .. ")",
		"JobId: " .. game.JobId,
		"Player: " .. (lp and (lp.Name .. " (UserId " .. lp.UserId .. ")") or "?"),
		"Players in server: " .. #P:GetPlayers(),
		"Executor: " .. (identifyexecutor and table.concat({ identifyexecutor() }, " ") or "unknown"),
	}
	local hrp = lp and lp.Character and lp.Character:FindFirstChild("HumanoidRootPart")
	if hrp then lines[#lines + 1] = "Character position: " .. tostring(hrp.Position) end
	return table.concat(lines, "\n")
end

function flux.tree(path, depth, maxChildren)
	local root = flux.find(path)
	depth = math.clamp(tonumber(depth) or 2, 1, 6)
	maxChildren = math.clamp(tonumber(maxChildren) or 25, 1, 200)
	local out = { (root == game and "game" or root:GetFullName()) .. " [" .. root.ClassName .. "]" }
	local function walk(inst, d, pad)
		local kids = inst:GetChildren()
		for i, c in ipairs(kids) do
			if i > maxChildren or #out > 1500 then
				out[#out + 1] = pad .. "... " .. (#kids - i + 1) .. " more"
				break
			end
			local n = #c:GetChildren()
			out[#out + 1] = pad .. c.Name .. " [" .. c.ClassName .. "]" .. (n > 0 and (" (" .. n .. " children)") or "")
			if d < depth then walk(c, d + 1, pad .. "  ") end
		end
	end
	walk(root, 1, "  ")
	return table.concat(out, "\n")
end

function flux.search(path, name, class, limit)
	local root = flux.find(path or "game")
	limit = math.clamp(tonumber(limit) or 30, 1, 300)
	name = (name and name ~= "") and string.lower(tostring(name)) or nil
	class = (class and class ~= "") and tostring(class) or nil
	local out, n = {}, 0
	for _, d in ipairs(root:GetDescendants()) do
		if (not class or d:IsA(class)) and (not name or string.find(string.lower(d.Name), name, 1, true)) then
			n = n + 1
			if n <= limit then out[#out + 1] = d:GetFullName() .. " [" .. d.ClassName .. "]" end
		end
	end
	if n > limit then out[#out + 1] = "... " .. (n - limit) .. " more matches" end
	return #out > 0 and table.concat(out, "\n") or "no matches"
end

function flux.source(path)
	local s = flux.find(path)
	if not s:IsA("LuaSourceContainer") then error(s:GetFullName() .. " is not a script", 0) end
	if not decompile then error("this executor has no decompile function", 0) end
	local ok, src = pcall(decompile, s)
	if not ok then error("decompile failed: " .. tostring(src), 0) end
	return src
end

function flux.console(limit, filter)
	local hist = LogService:GetLogHistory()
	limit = math.clamp(tonumber(limit) or 30, 1, 300)
	filter = (filter and filter ~= "") and string.lower(tostring(filter)) or nil
	local out = {}
	for i = #hist, 1, -1 do
		local m = hist[i]
		if not filter or string.find(string.lower(m.message), filter, 1, true) then
			local kind = string.gsub(tostring(m.messageType), "^.*%.Message", "")
			table.insert(out, 1, "[" .. kind .. "] " .. string.sub(m.message, 1, 600))
			if #out >= limit then break end
		end
	end
	return #out > 0 and table.concat(out, "\n") or "no console lines"
end

local function fire(sig, ...)
	if firesignal then
		return pcall(firesignal, sig, ...)
	elseif getconnections then
		local args, any = table.pack(...), false
		for _, c in ipairs(getconnections(sig)) do
			if pcall(function() c:Fire(table.unpack(args, 1, args.n)) end) then any = true end
		end
		return any
	end
	return false
end

function flux.click(path)
	local b = flux.find(path)
	local fired = 0
	for _, name in ipairs({ "MouseButton1Down", "MouseButton1Click", "MouseButton1Up", "Activated" }) do
		local ok, sig = pcall(function() return b[name] end)
		if ok and typeof(sig) == "RBXScriptSignal" and fire(sig) then fired = fired + 1 end
	end
	if fired == 0 then error("no click signal could be fired (needs firesignal or getconnections)", 0) end
	return "clicked " .. b:GetFullName()
end

function flux.type(path, text, enter)
	local tb = flux.find(path)
	if not tb:IsA("TextBox") then error(tb:GetFullName() .. " is not a TextBox", 0) end
	tb.Text = tostring(text or "")
	if enter then fire(tb.FocusLost, true) end
	return "typed into " .. tb:GetFullName()
end

-- remote spy: logs FireServer / InvokeServer calls made by the game
local spy = { on = false, hooked = false, log = {} }
function flux.spy(op, filter, limit)
	op = op or "list"
	if op == "start" then
		if not spy.hooked then
			if not (hookmetamethod and getnamecallmethod) then error("this executor cannot hook remotes (needs hookmetamethod)", 0) end
			local old
			local function hook(self, ...)
				if spy.on and not (checkcaller and checkcaller()) then
					local m = getnamecallmethod()
					if m == "FireServer" or m == "InvokeServer" then
						local parts, args = {}, table.pack(...)
						for i = 1, math.min(args.n, 8) do parts[i] = short(args[i]) end
						local ok, name = pcall(self.GetFullName, self)
						spy.log[#spy.log + 1] = os.date("%H:%M:%S") .. " " .. m .. " " .. (ok and name or "?") .. "(" .. table.concat(parts, ", ") .. ")"
						if #spy.log > 400 then table.remove(spy.log, 1) end
					end
				end
				return old(self, ...)
			end
			old = hookmetamethod(game, "__namecall", newcclosure and newcclosure(hook) or hook)
			spy.hooked = true
		end
		spy.on = true
		return "remote spy is on"
	elseif op == "stop" then
		spy.on = false
		return "remote spy is off (" .. #spy.log .. " calls kept)"
	elseif op == "clear" then
		spy.log = {}
		return "remote spy log cleared"
	end
	limit = math.clamp(tonumber(limit) or 30, 1, 400)
	filter = (filter and filter ~= "") and string.lower(tostring(filter)) or nil
	local out = {}
	for i = #spy.log, 1, -1 do
		if not filter or string.find(string.lower(spy.log[i]), filter, 1, true) then
			table.insert(out, 1, spy.log[i])
			if #out >= limit then break end
		end
	end
	return (spy.on and "spy on" or "spy off") .. ", " .. #spy.log .. " calls logged\n" .. table.concat(out, "\n")
end

-- ---------------------------------------------------------------- running code sent from Flux Control
local lastId = read("run.id") -- anything already there is old, so it is not run again

local function encode(v)
	if type(v) == "table" then
		local ok, j = pcall(Http.JSONEncode, Http, v)
		if ok then return j end
	end
	return tostring(v)
end

local function run(code, id)
	local logs = {}
	local function add(prefix, ...)
		local parts = {}
		for i = 1, select("#", ...) do
			parts[i] = tostring((select(i, ...)))
		end
		logs[#logs + 1] = prefix .. table.concat(parts, " ")
		if #logs > 200 then table.remove(logs, 1) end
	end
	write("status.json", Http:JSONEncode({ id = id, running = true }))

	local fn, err = loadstring(code, "=HubRunner")
	local ok, result = false, tostring(err)
	if fn then
		-- print and warn go back to Flux Control; everything else is the normal executor environment
		local env = setmetatable({
			print = function(...) add("", ...) end,
			warn = function(...) add("[warn] ", ...) end,
			flux = flux,
		}, { __index = G, __newindex = G })
		pcall(setfenv, fn, env)
		ok, result = xpcall(fn, function(e) return debug.traceback(tostring(e), 2) end)
		if ok then result = result ~= nil and encode(result) or nil end
	end
	write("status.json", Http:JSONEncode({
		id = id, ok = ok, error = (not ok) and tostring(result) or nil,
		result = ok and result or nil, logs = logs, finished = os.time(),
	}))
end

task.spawn(function()
	local beat = 0
	while not state.stop do
		if os.clock() - beat > 1 then
			beat = os.clock()
			write("alive.txt", tostring(os.time()))
		end
		local id = read("run.id")
		if id and id ~= lastId then
			lastId = id
			local code = read("run.lua")
			if code and #code > 0 then
				task.spawn(run, code, id) -- own thread, so long code does not stop the checks
			end
		end
		task.wait(0.15)
	end
end)

print("[HubRunner] watching " .. DIR .. " (run it again to replace)")
