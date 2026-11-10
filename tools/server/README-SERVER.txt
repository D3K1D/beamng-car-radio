CarRadio for a BeamMP server
============================

What this does: players running CarRadio hear each other's car radios. Audio goes
through a small relay program next to your BeamMP server; BeamMP itself only tells
players where the relay is.

1. Copy the contents of this zip into your BeamMP server folder (the folder that
   contains "Resources"):
     Resources/Client/carradio_d3k1d.zip   - sent to players automatically on join
     Resources/Server/CarRadio/            - the server plugin and its settings
     CarRadioRelay/                        - the relay (Windows .exe and Linux binary)
     start-relay.bat / start-relay.sh

2. Edit Resources/Server/CarRadio/carradio.json:
     "relay_public_address": the address players use to reach this machine plus the
                             relay port, e.g. "203.0.113.5:38800" or "myserver.example.com:38800"
     "relay_port":           38800 (change both places if you use another port)
     "secret":               any long random passcode (at least 8 characters)

3. Allow TCP port 38800 in the firewall, and forward it on your router if you host
   from home (same as you did for the BeamMP port).

4. Start the relay (start-relay.bat on Windows, ./start-relay.sh on Linux) and keep
   it running, then (re)start the BeamMP server. The server console should show:
     [CarRadio] ready; relay <your address>

Players need CarRadio Companion installed (CarRadio-Setup.exe) and running.

Hosting and playing on the same PC: some routers do not let you reach your own public
address from inside your network. If you hear nobody, that is the likely reason; your
friends will still hear each other and you.
