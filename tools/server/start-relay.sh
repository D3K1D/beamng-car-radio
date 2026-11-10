#!/bin/sh
# Starts the CarRadio relay with the settings from the BeamMP plugin's carradio.json.
# Run this from your BeamMP server folder (the one that contains Resources).
cd "$(dirname "$0")"
chmod +x CarRadioRelay/CarRadioRelay-linux
exec ./CarRadioRelay/CarRadioRelay-linux --config Resources/Server/CarRadio/carradio.json
