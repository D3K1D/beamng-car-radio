-- CarRadio: game-engine side.
--  * Connects to the CarRadio Companion on 127.0.0.1:38742 (protocol/companion-link.md)
--    and relays its Opus packets to the HUD app (the UI browser cannot open local sockets).
--  * Tracks the player's radio car and, on BeamMP, other players' radio cars, and sends the
--    UI each car's position relative to the camera plus its condition (inside, damage,
--    ignition, size), using only data every stock or modded vehicle has.
--  * On BeamMP, asks the server plugin for the relay address and tells the companion which
--    car key to broadcast under (protocol/multiplayer.md).
-- Plays no native audio; all sound is rendered by the HUD app.

local M = {}

local socket = require('socket')
local mime = require('mime')

local logTag = 'carradio'
local VERSION = '0.1.0'
local PROTO = 1
local LINK_PORT = 38742

-- ---------------------------------------------------------------- helpers
local function vecTable(v) return { v.x, v.y, v.z } end

-- World position -> {right, up, back} metres from the camera (WebAudio's default listener).
local function toCameraSpace(worldPos, camPos, camRight, camFwd, camUp)
  local d = vec3(worldPos) - camPos
  return { d:dot(camRight), d:dot(camUp), -d:dot(camFwd) }
end

local function u32le(n)
  return string.char(n % 256, math.floor(n / 256) % 256, math.floor(n / 65536) % 256, math.floor(n / 16777216) % 256)
end
local function readU32le(s, i)
  local a, b, c, d = s:byte(i, i + 3)
  return a + b * 256 + c * 65536 + d * 16777216
end

-- ---------------------------------------------------------------- companion link
local link = { sock = nil, buf = '', nextTry = 0, hello = nil, status = nil, relay = nil }
local pending = {} -- [streamKey] = { seq = firstSeq, packets = {b64...} } for this frame

local function linkSend(frameType, payload)
  if not link.sock then return end
  local ok = link.sock:send(u32le(#payload + 1) .. string.char(frameType) .. payload)
  if not ok then link.sock:close(); link.sock = nil end
end

local function queuePacket(key, seq, opus)
  local p = pending[key]
  if not p then p = { seq = seq, packets = {} }; pending[key] = p end
  p.packets[#p.packets + 1] = mime.b64(opus)
end

local lastSession = nil
local function sendSession(session)
  local json = jsonEncode(session or { relay = false })
  if json == lastSession then return end
  lastSession = json
  linkSend(0x11, json)
end

local function onLinkFrame(t, payload)
  if t == 0x02 then
    queuePacket('own', readU32le(payload, 1), payload:sub(5))
  elseif t == 0x04 then
    local keyLen = payload:byte(1)
    local key = payload:sub(2, 1 + keyLen)
    queuePacket(key, readU32le(payload, 2 + keyLen), payload:sub(6 + keyLen))
  elseif t == 0x01 then
    link.hello = jsonDecode(payload)
    log('I', logTag, 'companion connected: ' .. tostring(link.hello and link.hello.version))
  elseif t == 0x03 then
    link.status = jsonDecode(payload)
  elseif t == 0x05 then
    link.relay = jsonDecode(payload)
  end
end

local function linkUpdate()
  if not link.sock then
    local now = os.clock()
    if now < link.nextTry then return end
    link.nextTry = now + 2
    local s = socket.tcp()
    s:settimeout(0.02) -- loopback: refused or accepted almost immediately
    if s:connect('127.0.0.1', LINK_PORT) then
      s:settimeout(0)
      s:setoption('tcp-nodelay', true)
      link.sock, link.buf = s, ''
      lastSession = nil
      linkSend(0x10, jsonEncode({ proto = PROTO, app = 'carradio', version = VERSION }))
    else
      s:close()
    end
    return
  end
  -- Drain whatever arrived, up to 512 KiB per frame.
  local parts, total = {}, 0
  while total < 524288 do
    local data, err, partial = link.sock:receive(65536)
    local chunk = data or partial
    if chunk and #chunk > 0 then parts[#parts + 1] = chunk; total = total + #chunk end
    if err == 'closed' then
      link.sock:close(); link.sock = nil; link.hello = nil; link.status = nil; link.relay = nil
      log('I', logTag, 'companion disconnected')
      break
    end
    if not data then break end
  end
  if total > 0 then
    local buf = link.buf .. table.concat(parts)
    local pos = 1
    while #buf - pos + 1 >= 4 do
      local len = readU32le(buf, pos)
      if len < 1 or len > 65536 then
        log('E', logTag, 'bad frame from companion; reconnecting')
        if link.sock then link.sock:close(); link.sock = nil end
        buf, pos = '', 1
        break
      end
      if #buf - pos + 1 < 4 + len then break end
      onLinkFrame(buf:byte(pos + 4), buf:sub(pos + 5, pos + 3 + len))
      pos = pos + 4 + len
    end
    link.buf = buf:sub(pos)
  end
end

-- ---------------------------------------------------------------- vehicles
local vehInfo = {} -- [vehId] = { mass = kg, length = m, requested = true }

local function isUnicycle(veh) return veh and veh:getJBeamFilename() == 'unicycle' end

local function requestVehicleInfo(veh, withShake)
  local id = veh:getId()
  vehInfo[id] = vehInfo[id] or {}
  vehInfo[id].requested = true
  veh:queueLuaCommand("local m = 0 for _, n in pairs(v.data.nodes) do m = m + (n.nodeWeight or 0) end " ..
    "obj:queueGameEngineLua('carradio_main.onVehicleMass(' .. objectId .. ',' .. m .. ')')")
  core_vehicleBridge.registerValueChangeNotification(veh, 'ignitionLevel')
  if withShake then veh:queueLuaCommand('extensions.load("carradio_bassShake")') end
end

local function onVehicleMass(vehId, mass)
  vehInfo[vehId] = vehInfo[vehId] or {}
  vehInfo[vehId].mass = mass
end

-- Dashboard centre: driver seat camera node projected onto the centreline, 0.5 m forward.
-- Vehicles without a driver seat fall back to the bounding-box centre.
local seatPos = vec3()
local function radioAnchor(veh)
  local dir = vec3(veh:getDirectionVector())
  local up = vec3(veh:getDirectionVectorUp())
  local right = dir:cross(up)
  local center = vec3(veh:getSpawnWorldOOBB():getCenter())
  local camNodeID = core_camera.getDriverDataById(veh:getId())
  if camNodeID then
    seatPos:set(veh:getNodeAbsPositionXYZ(camNodeID))
    return seatPos - right * ((seatPos - center):dot(right)) + dir * 0.5
  end
  return center
end

local function insideBox(veh, camPos, margin)
  local box = veh:getSpawnWorldOOBB()
  local c, h = box:getCenter(), box:getHalfExtents()
  local d = camPos - vec3(c)
  for i = 0, 2 do
    local half = (i == 0 and h.x) or (i == 1 and h.y) or h.z
    if math.abs(d:dot(vec3(box:getAxis(i)))) > half + margin then return false end
  end
  return true
end

local function isCabinCamera(camName)
  return camName == 'driver' or camName == 'onboard.driver' or (camName and camName:find('^occupant%.') ~= nil)
end

local lastInside = {} -- [vehId] = bool, for exit hysteresis

-- Everything the UI needs to render one radio car.
local function radioState(veh, cam)
  local id = veh:getId()
  local info = vehInfo[id]
  if not info or not info.requested then requestVehicleInfo(veh, false); info = vehInfo[id] end
  local inside
  if cam.playerVehId == id and isCabinCamera(cam.name) then
    inside = true
  else
    local ok, r = pcall(insideBox, veh, cam.pos, lastInside[id] and 0.4 or 0)
    inside = ok and r or false
  end
  lastInside[id] = inside
  local okA, anchor = pcall(radioAnchor, veh)
  if not okA then anchor = vec3(veh:getPosition()) end
  if not info.length then
    local okL, h = pcall(function() return veh:getSpawnWorldOOBB():getHalfExtents() end)
    if okL then info.length = 2 * math.max(h.x, h.y, h.z) end
  end
  local mapObj = map and map.objects and map.objects[id]
  local damage = mapObj and mapObj.damage or 0
  return {
    rel = toCameraSpace(anchor, cam.pos, cam.right, cam.fwd, cam.up),
    inside = inside,
    damagePerKg = (info.mass and info.mass > 0) and damage / info.mass or nil,
    ignition = core_vehicleBridge.getCachedVehicleData(id, 'ignitionLevel'),
    length = info.length,
  }
end

-- ---------------------------------------------------------------- own radio
local radio = { on = false, vehId = nil }

local function currentDrivableVehicle()
  local veh = getPlayerVehicle(0)
  if veh and not isUnicycle(veh) then return veh end
end

local function setRadioVehicle(veh)
  local old = radio.vehId and be:getObjectByID(radio.vehId)
  if old then old:queueLuaCommand('extensions.unload("carradio_bassShake")') end
  radio.vehId = veh and veh:getId() or nil
  if veh then vehInfo[radio.vehId] = nil; requestVehicleInfo(veh, true) end
end

-- Called by the UI play button.
local function setOn(on)
  radio.on = on and true or false
  if radio.on then
    setRadioVehicle(currentDrivableVehicle())
  else
    setRadioVehicle(nil)
  end
  log('I', logTag, 'radio ' .. (radio.on and ('on in vehicle ' .. tostring(radio.vehId)) or 'off'))
end

-- The radio moves with you into another car (not into the walking character).
local function onVehicleSwitched(oldId, newId, player)
  if not radio.on or (player and player ~= 0) then return end
  local veh = newId and be:getObjectByID(newId)
  if veh and not isUnicycle(veh) and (not MPVehicleGE or MPVehicleGE.isOwn(newId)) then setRadioVehicle(veh) end
end

local function onVehicleReplaced(vehId)
  vehInfo[vehId] = nil
  if vehId == radio.vehId then local veh = be:getObjectByID(vehId); if veh then requestVehicleInfo(veh, true) end end
end

-- Bass level from the UI, forwarded to the radio car's shake extension.
local function setBass(x, mult)
  local veh = radio.vehId and be:getObjectByID(radio.vehId)
  if veh then veh:queueLuaCommand(string.format('if carradio_bassShake then carradio_bassShake.setLevel(%.3f, %.1f) end', tonumber(x) or 0, tonumber(mult) or 1)) end
end

-- ---------------------------------------------------------------- BeamMP
local mp = { config = nil, nextHello = 0, handlersAdded = false, remotes = {} } -- remotes[key] = lastPacketTime

local function inMP()
  return MPCoreNetwork and MPCoreNetwork.isMPSession and MPCoreNetwork.isMPSession() and true or false
end

local function mpUpdate(now)
  if not inMP() then
    if mp.config then mp.config = nil end
    sendSession(nil)
    return
  end
  if not mp.handlersAdded and AddEventHandler then
    AddEventHandler('carradio_config', function(data)
      local ok, cfg = pcall(jsonDecode, data)
      if ok and type(cfg) == 'table' and cfg.relay then
        mp.config = cfg
        log('I', logTag, 'server relay: ' .. tostring(cfg.relay))
      end
    end, 'carradio') -- named, so a Lua reload replaces the handler instead of adding another
    mp.handlersAdded = true
  end
  if not mp.config then
    if now >= mp.nextHello and TriggerServerEvent then
      mp.nextHello = now + 10
      TriggerServerEvent('carradio_hello', VERSION) -- plugin answers with carradio_config
    end
    return
  end
  local key = ''
  if radio.on and radio.vehId and getServerVehicleID then key = getServerVehicleID(radio.vehId) or '' end
  sendSession({ relay = mp.config.relay, secret = mp.config.secret, key = key })
end

-- ---------------------------------------------------------------- per frame
local sendInterval, sinceSend = 1 / 60, 0

local function onUpdate(dtReal)
  linkUpdate()
  local now = os.clock()

  -- Audio: one UI message per stream per frame.
  for key, p in pairs(pending) do
    if key ~= 'own' then mp.remotes[key] = now end
    guihooks.trigger('CarRadioAudio', { k = key, s = p.seq, p = p.packets })
  end
  pending = {}

  sinceSend = sinceSend + dtReal
  if sinceSend < sendInterval then return end
  sinceSend = 0
  mpUpdate(now)

  local cam = {
    pos = core_camera.getPosition(), right = core_camera.getRight(), fwd = core_camera.getForward(), up = core_camera.getUp(),
    name = core_camera.getActiveCamName(0), playerVehId = be:getPlayerVehicleID(0),
  }
  local state = {
    paused = simTimeAuthority.getPause() and true or false,
    companion = link.sock and { version = link.hello and link.hello.version, source = link.status and link.status.source,
      capturing = link.status and link.status.capturing or false } or false,
    relay = link.relay or false,
    mp = inMP(),
    radioOn = radio.on,
    radios = {},
  }
  if radio.on and radio.vehId then
    local veh = be:getObjectByID(radio.vehId)
    if veh then
      local r = radioState(veh, cam)
      r.k = 'own'
      state.radios[#state.radios + 1] = r
    end
  end
  for key, last in pairs(mp.remotes) do
    if now - last > 3 then
      mp.remotes[key] = nil
    elseif getGameVehicleID then
      local gid = getGameVehicleID(key)
      local veh = gid and gid ~= -1 and be:getObjectByID(gid)
      if veh then
        local r = radioState(veh, cam)
        r.k = key
        state.radios[#state.radios + 1] = r
      end
    end
  end
  guihooks.trigger('CarRadioState', state)
end

local function onExtensionUnloaded()
  setRadioVehicle(nil)
  if link.sock then link.sock:close(); link.sock = nil end
end

M.onUpdate = onUpdate
M.onExtensionUnloaded = onExtensionUnloaded
M.onVehicleSwitched = onVehicleSwitched
M.onVehicleReplaced = onVehicleReplaced
M.onVehicleSpawned = onVehicleReplaced
M.onVehicleMass = onVehicleMass
M.setOn = setOn
M.setBass = setBass

return M
