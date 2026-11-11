-- CarRadio: bass shake (vehicle Lua, loads as "carradio_bassShake").
-- Shakes the vehicle with the radio's bass when the BASS button is on. Level comes
-- from the HUD app (via game-engine Lua) about 30 times a second.
-- Works on any vehicle: nodes are picked from the vehicle's own node list and every
-- force is scaled by that node's mass, so a bus and a hatchback react alike.
-- While shaking, a gentle upright assist pulls roll/pitch back towards level and damps
-- tumbling, so bass hits don't flip the car in the air. It never acts on yaw (steering)
-- and gives up beyond 80 degrees of tilt.

local M = {}

local FREQ = 42          -- Hz, "subwoofer" buzz
local DECIM = 4          -- apply forces every 4th physics step (~500 Hz at 2 kHz physics)
local MAX_G = 40         -- buzz acceleration at full drive (g)
local KICK_G = 25        -- shared upward thump per unit of bass-hit strength (g)
local THRESHOLD = 0.3    -- level below which nothing happens
local SPAN = 1.2         -- level range above threshold that maps to full drive
local MAX_NODES = 32

-- Upright assist: target angular acceleration = KP * tilt - KD * tumble rate (rad/s^2).
local ASSIST_KP = 12         -- ~3.5 rad/s natural frequency: gentle, not a gyroscope
local ASSIST_KD = 7          -- ~critically damped: mainly stops tumbling in the air
local ASSIST_MAX = 25        -- cap (rad/s^2)
local ASSIST_HOLD = 1.5      -- keep assisting this long after the last shake (s)
local ASSIST_MAX_TILT_COS = math.cos(math.rad(80))

-- Lowrider hop: on each beat the front or the rear (alternating) is thrown upwards.
local HOP_G = 30             -- upward acceleration of the hopping half at full drive (g)
local HOP_TIME = 0.09        -- seconds each hop push lasts
local BEAT_MIN_GAP = 0.2     -- seconds between beats at most 5/s
local BEAT_RATIO = 1.35      -- a beat is a bass hit this far above the recent average

local level, smoothed, kick = 0, 0, 0
local multiplier = 1 -- ULTRA BASS BOOST = 5
local mode = 1       -- 0 = no shake, 1 = buzz, 2 = lowrider hop
local beatAvg, lastBeatT = 0, -100
local hopUntil, hopFront = -1, true
local nodes = {}
local totalMass, selMass = 0, 0
local t, steps = 0, 0
local lastShakeT = -100
local prevUp, prevFwd = nil, nil
local twoPi = 2 * math.pi
local worldUp = vec3(0, 0, 1)

local function pickNodes()
  nodes = {}
  totalMass, selMass = 0, 0
  local all = {}
  for _, n in pairs(v.data.nodes) do
    if n.cid and (n.nodeWeight or 0) > 0 then all[#all + 1] = n; totalMass = totalMass + n.nodeWeight end
  end
  table.sort(all, function(a, b) return a.cid < b.cid end)
  local stride = math.max(1, math.floor(#all / MAX_NODES))
  for i = 1, #all, stride do
    local n = all[i]
    nodes[#nodes + 1] = { cid = n.cid, mass = n.nodeWeight, phase = math.random() * twoPi }
    selMass = selMass + n.nodeWeight
  end
  -- Front or rear half (for the lowrider hop), from where each node sits along the car.
  local fwd, c = obj:getDirectionVector(), vec3(0, 0, 0)
  for i = 1, #nodes do nodes[i].pos = obj:getNodePosition(nodes[i].cid); c = c + nodes[i].pos * nodes[i].mass end
  c = c / math.max(selMass, 1)
  for i = 1, #nodes do nodes[i].front = (nodes[i].pos - c):dot(fwd) > 0 end
end

-- From the HUD app (via game-engine Lua): bass level, ULTRA multiplier, shake mode.
-- (The 4th argument, once a high-beam light show, is ignored: CarRadio never touches a
-- car's own lights. The light show is underglow drawn by game-engine Lua.)
local function setLevel(x, mult, newMode)
  multiplier = math.max(0, math.min(5, tonumber(mult) or 1))
  mode = tonumber(newMode) or 1
  x = tonumber(x) or 0
  if x > level then kick = math.max(kick, x - level) end -- a rising edge is a bass hit
  -- Beat detection (for the hop).
  local isBeat = x > 0.08 and x > beatAvg * BEAT_RATIO and t - lastBeatT > BEAT_MIN_GAP
  beatAvg = beatAvg + (x - beatAvg) * 0.05
  if isBeat then
    lastBeatT = t
    if mode == 2 then hopUntil = t + HOP_TIME; hopFront = not hopFront end
  end
  level = x
end

-- Pure-torque nudge towards upright (no net force): F_i = m_i * (alpha x (r_i - c)),
-- with c the mass centre of the sampled nodes, scaled up to the whole vehicle's mass.
local function uprightAssist(up, fwd, dtApply, strength)
  -- Angular velocity from how the car's axes turned since the last step:
  -- omega = 0.5 * sum(axis x d(axis)) / dt over three orthonormal axes.
  local right = fwd:cross(up)
  local omega = vec3(0, 0, 0)
  if prevUp then
    local prevRight = prevFwd:cross(prevUp)
    omega = (up:cross(up - prevUp) + fwd:cross(fwd - prevFwd) + right:cross(right - prevRight)) * (0.5 / dtApply)
  end
  prevUp, prevFwd = vec3(up), vec3(fwd)
  if strength <= 0 or up:dot(worldUp) < ASSIST_MAX_TILT_COS then return end
  -- Ignore spin about the car's own up axis (yaw): never fight steering or drifts.
  local tumble = omega - up * omega:dot(up)
  local alpha = up:cross(worldUp) * ASSIST_KP - tumble * ASSIST_KD
  local mag = alpha:length()
  if mag > ASSIST_MAX then alpha = alpha * (ASSIST_MAX / mag) end
  alpha = alpha * (strength * totalMass / math.max(selMass, 1))
  -- Lever arms about the sampled nodes' mass centre.
  local c = vec3(0, 0, 0)
  for i = 1, #nodes do
    local n = nodes[i]
    n.pos = obj:getNodePosition(n.cid)
    c = c + n.pos * n.mass
  end
  c = c / math.max(selMass, 1)
  for i = 1, #nodes do
    local n = nodes[i]
    obj:applyForceVectorTime(n.cid, alpha:cross(n.pos - c) * n.mass, dtApply)
  end
end

local function onPhysicsStep(dt)
  steps = steps + 1
  t = t + dt
  if steps % DECIM ~= 0 then return end
  smoothed = smoothed + (level - smoothed) * 0.08
  kick = kick * 0.97
  local drive = math.min(3, math.max(0, (smoothed - THRESHOLD) / SPAN)) -- keeps growing past 300% volume
  local kickDrive = drive > 0 and kick or 0
  local applyTime = dt * DECIM
  local up = obj:getDirectionVectorUp()
  local fwd = obj:getDirectionVector()
  if mode == 1 and (drive > 0 or kickDrive >= 0.01) then
    -- Buzz: every sampled node vibrates (random phases) plus a shared thump on hits.
    lastShakeT = t
    local buzz = MAX_G * 9.81 * drive * drive * multiplier
    local thump = KICK_G * 9.81 * kickDrive * multiplier
    local w = twoPi * FREQ * t
    for i = 1, #nodes do
      local n = nodes[i]
      local a = buzz * math.sin(w + n.phase) + thump
      obj:applyForceVectorTime(n.cid, up * (n.mass * a), applyTime)
    end
  elseif mode == 2 and t < hopUntil and drive > 0 then
    -- Lowrider hop: push the front or the rear half up for a moment, alternating each beat.
    lastShakeT = t
    local a = HOP_G * 9.81 * math.min(1.5, drive) * (multiplier > 1 and 2 or 1)
    for i = 1, #nodes do
      local n = nodes[i]
      if n.front == hopFront then obj:applyForceVectorTime(n.cid, up * (n.mass * a), applyTime) end
    end
  end
  -- Assist while shaking and shortly after (stronger with ULTRA, whose hits are harder;
  -- softer for the hop, which is meant to pitch the car).
  local since = t - lastShakeT
  local strength = since < ASSIST_HOLD and math.min(1, 1 - since / ASSIST_HOLD + 0.2) * (multiplier > 1 and 1.6 or 1) * (mode == 2 and 0.4 or 1) or 0
  if strength > 0 then uprightAssist(up, fwd, applyTime, strength) else prevUp = nil end
end

local function onExtensionLoaded()
  pickNodes()
  enablePhysicsStepHook()
end

local function onReset()
  level, smoothed, kick = 0, 0, 0
  lastShakeT, prevUp, prevFwd = -100, nil, nil
end

M.onExtensionLoaded = onExtensionLoaded
M.onPhysicsStep = onPhysicsStep
M.onReset = onReset
M.setLevel = setLevel

return M
