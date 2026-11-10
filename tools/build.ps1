# Builds every CarRadio release file into dist/:
#   CarRadio-Setup-<ver>.exe     player installer (companion + optional single-player mod)
#   CarRadio-Server-<ver>.zip    BeamMP server pack (client mod, plugin, relay for Windows/Linux)
#   carradio_d3k1d.zip           the client mod on its own
# Requires: MinGW g++ (capture helper), .NET 9 SDK, Inno Setup 6.
param([string]$Version = "0.1.0")
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$dist = Join-Path $root 'dist'
$stage = Join-Path $root '.local\stage'
Remove-Item -Recurse -Force $stage -ErrorAction SilentlyContinue
Get-ChildItem $dist -File -ErrorAction SilentlyContinue | Remove-Item -Force
New-Item -ItemType Directory -Force $dist, "$stage\companion" | Out-Null

Write-Host "== capture helper"
& g++ -std=c++17 -O2 -Wall -Wextra -static -static-libgcc -static-libstdc++ "$root\companion\native\appcapture.cpp" -lole32 -loleaut32 -lmmdevapi -luuid -o "$root\companion\native\appcapture.exe"
if ($LASTEXITCODE) { throw 'appcapture build failed' }

Write-Host "== companion (self-contained single file)"
# Separate output folder so a running dev copy of the companion can't lock the build.
dotnet publish "$root\companion\CarRadio.Companion\CarRadio.Companion.csproj" -c Release -p:Version=$Version "-p:BaseOutputPath=$root\.local\build\companion/" -o "$stage\companion" --nologo -v q
if ($LASTEXITCODE) { throw 'companion publish failed' }

Write-Host "== relay (Windows + Linux, self-contained single file)"
foreach ($rid in 'win-x64', 'linux-x64') {
  dotnet publish "$root\relay\CarRadio.Relay\CarRadio.Relay.csproj" -c Release -r $rid --self-contained -p:PublishSingleFile=true -p:EnableCompressionInSingleFile=true -p:Version=$Version -o "$stage\relay\$rid" --nologo -v q
  if ($LASTEXITCODE) { throw "relay publish failed ($rid)" }
}

# Zip a folder's contents with forward-slash entry names (Compress-Archive in Windows
# PowerShell writes backslashes, which unpack as literal file names on Linux).
Add-Type -AssemblyName System.IO.Compression, System.IO.Compression.FileSystem
function New-Zip([string]$folder, [string]$zipPath) {
  if (Test-Path $zipPath) { Remove-Item -Force $zipPath }
  $zip = [System.IO.Compression.ZipFile]::Open($zipPath, 'Create')
  try {
    Get-ChildItem -Recurse -File $folder | ForEach-Object {
      $rel = $_.FullName.Substring($folder.TrimEnd('\').Length + 1).Replace('\', '/')
      [void][System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $_.FullName, $rel, 'Optimal')
    }
  } finally { $zip.Dispose() }
}

Write-Host "== client mod zip"
# Mod contents at the zip root (lua/, scripts/, ui/).
$modZip = Join-Path $stage 'carradio_d3k1d.zip'
New-Zip "$root\mod" $modZip
Copy-Item $modZip $dist

Write-Host "== server pack"
$srv = Join-Path $stage 'server'
New-Item -ItemType Directory -Force "$srv\Resources\Client", "$srv\Resources\Server\CarRadio", "$srv\CarRadioRelay" | Out-Null
Copy-Item $modZip "$srv\Resources\Client\"
Copy-Item "$root\beammp-server\CarRadio\*" "$srv\Resources\Server\CarRadio\"
Copy-Item "$stage\relay\win-x64\CarRadioRelay.exe" "$srv\CarRadioRelay\"
Copy-Item "$stage\relay\linux-x64\CarRadioRelay" "$srv\CarRadioRelay\CarRadioRelay-linux"
Copy-Item "$root\tools\server\*" "$srv\"
New-Zip $srv "$dist\CarRadio-Server-$Version.zip"

Write-Host "== installer"
Copy-Item "$root\tools\installer\README.txt" "$stage\README.txt"
$iscc = @("$env:LOCALAPPDATA\Programs\Inno Setup 6\ISCC.exe", "${env:ProgramFiles(x86)}\Inno Setup 6\ISCC.exe") | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $iscc) { throw 'Inno Setup 6 (ISCC.exe) not found' }
& $iscc /Q "/DAppVersion=$Version" "/DStage=$stage" "/DOutDir=$dist" "$root\tools\installer\CarRadio.iss"
if ($LASTEXITCODE) { throw 'installer build failed' }

Write-Host "== checksums"
Get-ChildItem $dist -File | ForEach-Object { "{0}  {1}" -f (Get-FileHash $_.FullName -Algorithm SHA256).Hash.ToLower(), $_.Name } | Set-Content "$dist\SHA256SUMS.txt" -Encoding ascii
Get-ChildItem $dist | Format-Table Name, @{n = 'MB'; e = { [math]::Round($_.Length / 1MB, 1) } } -AutoSize
