# CarRadio for BeamNG.drive

Play any program on your PC (Spotify, Chrome, VLC, anything) through your car in BeamNG.drive, in 3D. On BeamMP servers that run CarRadio, players hear each other's car radios.

**Status: 0.1.0, first build for private multiplayer testing with friends.** Single player has been tested in game, step by step, through the browser-probe stages. The multiplayer relay path has been tested locally (relay, companion and decoding), but not yet on a live BeamMP server.

## How it works

```text
Program on your PC --> CarRadio Companion --(loopback TCP)--> game Lua --> CarRadio HUD app
                       (per-app capture,                                  (WebCodecs Opus decode,
                        Opus encode)                                       3D + car effects per radio)
                              |
                              +--(TCP)--> CarRadio relay next to the BeamMP server --> other players
```

- **Companion** (`companion/`): a Windows app that captures the chosen program with Windows process-loopback capture and encodes it as Opus at 128 kbit/s. While the game is connected it turns that program down to −60 dB on your speakers and scales the capture back up losslessly, so you only hear it from the car.
- **Mod** (`mod/`, shipped as `carradio_d3k1d.zip`):
  - game Lua that relays the audio and works out each radio car's position and condition
  - an AudioWorklet jitter buffer, then a per-car WebAudio chain: HRTF 3D sound, muffling outside the car, a cabin character scaled by vehicle size, damage and crash effects, ignition, a bass boost that physically shakes the car (optionally ×5 with ULTRA), and a transparent look-ahead limiter
- **Relay** (`relay/`) and **BeamMP plugin** (`beammp-server/`): the audio goes through a separate relay, because BeamMP events share the vehicle-sync TCP connection (see [multiplayer design](protocol/multiplayer.md)). The plugin only tells players the relay's address and passcode.

Everything is vehicle-agnostic. Positions come from each vehicle's driver-seat node and bounding box, and damage is normalised per kg, so stock and modded vehicles behave alike.

## Install

- **Players:** run `CarRadio-Setup-<version>.exe` from the release, then follow its README (start the companion, pick a program, add the **CarRadio** app in game and press ▶).
- **Server owners:** unzip `CarRadio-Server-<version>.zip` into the BeamMP server folder and follow `README-SERVER.txt`. You set the relay address and passcode, open TCP 38800, and start the relay.

## Build

```powershell
.\tools\build.ps1 -Version 0.1.0
```

Requires MinGW g++, the .NET 9 SDK and Inno Setup 6. The output goes to `dist/`: the installer, the server pack, the mod zip and SHA-256 checksums.

## Docs

- [Phase 0 and effect measurements](docs/BROWSER_PROBE_RESULTS.md): every in-game result so far
- [Companion link protocol](protocol/companion-link.md) · [Multiplayer protocol](protocol/multiplayer.md)
- [Handoff](docs/HANDOFF.md), [Blueprint](docs/BLUEPRINT.md), and the earlier research in `docs/` and `research/`

Sharing captured music with other players is retransmission. It is meant for private groups of friends, not public servers. Not affiliated with Spotify, BeamNG or BeamMP. No open-source licence has been chosen yet; the repository is private.
