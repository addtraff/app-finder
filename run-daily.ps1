# Добовий знімок. Ставится в Планировщик заданий Windows на нужный час UTC.
# Пример регистрации (раз в сутки в 03:10):
#   schtasks /create /tn "play-radar-daily" /tr "powershell -NoProfile -File C:\ленды вайбкод\play-radar\run-daily.ps1" /sc daily /st 03:10
$ErrorActionPreference = "Stop"
Set-Location -Path $PSScriptRoot
$stamp = Get-Date -Format "yyyy-MM-dd"
New-Item -ItemType Directory -Force -Path "logs" | Out-Null
node src/cli.js daily *> "logs/daily-$stamp.log"
