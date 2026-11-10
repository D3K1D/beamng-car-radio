@echo off
rem Starts the CarRadio relay with the settings from the BeamMP plugin's carradio.json.
rem Run this from your BeamMP server folder (the one that contains Resources).
cd /d "%~dp0"
"CarRadioRelay\CarRadioRelay.exe" --config "Resources\Server\CarRadio\carradio.json"
pause
