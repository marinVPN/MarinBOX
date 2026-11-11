$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$ProgressPreference = 'SilentlyContinue'

$root = Split-Path $PSScriptRoot -Parent
$bin  = Join-Path $root 'bin'
New-Item -ItemType Directory -Force $bin | Out-Null

$zip = Join-Path $env:TEMP 'xray-windows-64.zip'
Write-Host 'Downloading Xray-core...'
Invoke-WebRequest 'https://github.com/XTLS/Xray-core/releases/latest/download/Xray-windows-64.zip' -OutFile $zip
Expand-Archive $zip -DestinationPath $bin -Force
Remove-Item $zip

if (-not (Test-Path (Join-Path $bin 'xray.exe'))) { throw 'xray.exe not found after extraction' }
Write-Host 'Done: bin\xray.exe, geoip.dat, geosite.dat'
