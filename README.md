# CarRadio for BeamNG.drive

Play any program on your PC — Spotify, Chrome, VLC, anything — through your car in BeamNG.drive, in 3D. On BeamMP servers running CarRadio, everyone hears each other's car radios.

**Status: Beta.** Download the latest build from [Releases](../../releases).

## Features

- Music comes from the car: 3D positioning, muffled from outside, a cabin sound scaled to the vehicle, open-window/damage/crash/ignition behaviour — works on any stock or modded vehicle
- ⏮ ⏯ ⏭ control the program you're playing; volume up to 1000%
- Bass boost that shakes the car (or makes it hop like a lowrider), ULTRA BASS BOOST, upright assist so it doesn't flip
- Underglow light show that pulses to the music, with an idle colour
- Louder with speed, separate muffle settings, damage effects toggle
- Multiplayer: hear friends' cars at their owner's volume, and **Convoy DJ** — tune your car to another player's music

## Install

**Players**
1. Run `CarRadio-Setup-<version>.exe` from the release.
2. Start **CarRadio Companion**, play your music, pick that program, press **Start**.
3. In BeamNG.drive: pause menu → UI Apps → add **CarRadio**.

**BeamMP server owners**
Unzip `CarRadio-Server-<version>.zip` into the server folder and follow `README-SERVER.txt` (set the relay address and passcode, open TCP 38800, start the relay).

## Repository

| Folder | Contents |
| --- | --- |
| `mod/` | The BeamNG mod (game Lua, vehicle Lua, HUD app) — shipped as `carradio_d3k1d.zip` |
| `companion/` | CarRadio Companion (Windows, .NET) and its audio capture helper (C++) |
| `relay/` | The audio relay that runs next to a BeamMP server (.NET, Windows/Linux) |
| `beammp-server/` | The BeamMP server plugin |
| `tools/` | `build.ps1` (builds everything into `dist/`), installer script, server scripts |

Build: `.\tools\build.ps1 -Version x.y.z` — needs MinGW g++, the .NET 9 SDK and Inno Setup 6.

Requires Windows 10 2004+ / Windows 11. Sharing captured music with other players is meant for private groups of friends. Not affiliated with Spotify, BeamNG or BeamMP.
