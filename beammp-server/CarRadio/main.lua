-- CarRadio BeamMP server plugin.
-- Tells joining players where this server's CarRadio relay is, so everyone hears each
-- other's car radios. The audio itself goes through the relay, not through BeamMP.
-- Configure Resources/Server/CarRadio/carradio.json (shared with the relay).

local CONFIG_PATH = "Resources/Server/CarRadio/carradio.json"
local config = nil

local function loadConfig()
  local f = io.open(CONFIG_PATH, "r")
  if not f then
    print("[CarRadio] " .. CONFIG_PATH .. " not found; players will hear only their own radios")
    return nil
  end
  local text = f:read("*a")
  f:close()
  local ok, cfg = pcall(Util.JsonDecode, text)
  if not ok or type(cfg) ~= "table" then
    print("[CarRadio] could not read " .. CONFIG_PATH)
    return nil
  end
  if not cfg.relay_public_address or cfg.relay_public_address == "" or cfg.relay_public_address:find("YOUR") then
    print("[CarRadio] set relay_public_address in " .. CONFIG_PATH .. " (the address players use to reach the relay)")
    return nil
  end
  if not cfg.secret or #cfg.secret < 8 or cfg.secret:find("change") then
    print("[CarRadio] set a secret of at least 8 characters in " .. CONFIG_PATH)
    return nil
  end
  return cfg
end

-- A client running the CarRadio mod asks for the relay details.
function carRadioOnHello(playerId, data)
  if not config then return end
  MP.TriggerClientEvent(playerId, "carradio_config", Util.JsonEncode({
    relay = config.relay_public_address,
    secret = config.secret,
  }))
end

config = loadConfig()
MP.RegisterEvent("carradio_hello", "carRadioOnHello")
if config then print("[CarRadio] ready; relay " .. config.relay_public_address) end
