-- CarRadio: bass shake (vehicle Lua, loads as "carradio_bassShake").
-- Shakes the vehicle with the radio's bass when the BASS button is on. Level comes
-- from the HUD app (via game-engine Lua) about 30 times a second.
-- Works on any vehicle: nodes are picked from the vehicle's own node list and every
-- force is scaled by that node's mass, so a bus and a hatchback react alike.

local M = {}

local FREQ = 42          -- Hz, "subwoofer" buzz
local DECIM = 4          -- apply forces every 4th physics step (~500 Hz at 2 kHz physics)
local MAX_G = 40         -- buzz acceleration at full drive (g)
local KICK_G = 25        -- shared upward thump per unit of bass-hit strength (g)
local THRESHOLD = 0.3    -- level below which nothing happens
local SPAN = 1.2         -- level range above threshold that maps to full drive
local MAX_NODES = 32

local level, smoothed, kick = 0, 0, 0
local multiplier = 1 -- ULTRA BASS BOOST = 5
local nodes = {}
local t, steps = 0, 0
local twoPi = 2 * math.pi

local function pickNodes()
  nodes = {}
  local all = {}
  for _, n in pairs(v.data.nodes) do
    if n.cid and (n.nodeWeight or 0) > 0 then all[#all + 1] = n end
  end
  table.sort(all, function(a, b) return a.cid < b.cid end)
  local stride = math.max(1, math.floor(#all / MAX_NODES))
  for i = 1, #all, stride do
    local n = all[i]
    nodes[#nodes + 1] = { cid = n.cid, mass = n.nodeWeight, phase = math.random() * twoPi }
  end
end

local function setLevel(x, mult)
  multiplier = math.max(0, math.min(5, tonumber(mult) or 1))
  x = tonumber(x) or 0
  if x > level then kick = math.max(kick, x - level) end -- a rising edge is a bass hit
  level = x
end

local function onPhysicsStep(dt)
  steps = steps + 1
  t = t + dt
  if steps % DECIM ~= 0 then return end
  smoothed = smoothed + (level - smoothed) * 0.08
  kick = kick * 0.97
  local drive = math.min(3, math.max(0, (smoothed - THRESHOLD) / SPAN)) -- keeps growing past 300% volume
  local kickDrive = drive > 0 and kick or 0
  if drive <= 0 and kickDrive < 0.01 then return end
  local up = obj:getDirectionVectorUp()
  local buzz = MAX_G * 9.81 * drive * drive * multiplier
  local thump = KICK_G * 9.81 * kickDrive * multiplier
  local applyTime = dt * DECIM
  local w = twoPi * FREQ * t
  for i = 1, #nodes do
    local n = nodes[i]
    local a = buzz * math.sin(w + n.phase) + thump
    obj:applyForceVectorTime(n.cid, up * (n.mass * a), applyTime)
  end
end

local function onExtensionLoaded()
  pickNodes()
  enablePhysicsStepHook()
end

local function onReset()
  level, smoothed, kick = 0, 0, 0
end

M.onExtensionLoaded = onExtensionLoaded
M.onPhysicsStep = onPhysicsStep
M.onReset = onReset
M.setLevel = setLevel

return M
