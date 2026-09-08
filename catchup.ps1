# Каждые полчаса добирает повільну роботу малими порціями.
# Поиск в Play жёстко лимитирован (429 уже на двух запросах в секунду),
# поэтому стадии перезапускаемы с места и берут только то, чего ещё нет за сегодня.
#   schtasks /create /tn "play-radar-catchup" /tr "powershell -NoProfile -File C:\ленды вайбкод\play-radar\catchup.ps1" /sc minute /mo 30
$ErrorActionPreference = "Continue"
Set-Location -Path $PSScriptRoot
$stamp = Get-Date -Format "yyyy-MM-dd"
New-Item -ItemType Directory -Force -Path "logs" | Out-Null
node src/cli.js stage keyword-serp --geo US --limit 12   *>> "logs/catchup-$stamp.log"
node src/cli.js stage enrich-apps  --geo US --limit 40   *>> "logs/catchup-$stamp.log"
node src/cli.js stage enrich-reviews --geo US --limit 15 *>> "logs/catchup-$stamp.log"
