# Ждёт, пока не останется ни одного запущенного этапа конвейера, и выполняет переданные
# команды по очереди. Нужен для правила «хвост после длинного процесса запускается сам».
#
# Почему не сторожить PID: этап конвейера — это отдельный процесс node на каждую стадию.
# Когда keyword-serp заканчивается и начинается enrich-apps, PID меняется, и сторож по
# одному PID решает, что всё кончилось, — 23.09 из-за этого пересчёт стартовал на середине
# сбора и ниши США остались на старых ключах. Поэтому проверяется не PID, а наличие любого
# node с src/cli.js в командной строке.
#
# Пустоты между стадиями. Планировщик запускает стадии одну за другой, и между ними есть
# секунды, когда ни одного процесса нет: сторож принял бы такую паузу за конец работы.
# Поэтому есть -MarkerFile: файл, который планировщик пишет по завершении отчётов
# (logs/reports.done). Ждём, пока он не обновится ПОСЛЕ -MarkerAfter, и только тогда
# считаем, что дневной цикл действительно закончился.
#
# Команды передаются одной строкой через «;;» — при запуске через -File PowerShell не умеет
# принимать массив: второй элемент уезжает в следующий позиционный параметр. Команда,
# начинающаяся с «tools/», запускается как отдельный скрипт, остальные — через src/cli.js.
#
#   powershell -File tools/wait-and-run.ps1 -Log logs/tail.log -MarkerFile logs/reports.done `
#     -MarkerAfter "2026-09-24T09:43" -Commands "stage score --geo US;;tools/predict-backfill.js"
param(
  [string]$Log = 'logs/wait-and-run.log',
  [string]$Commands = '',
  [string]$MarkerFile = '',
  [string]$MarkerAfter = '',
  [int]$PollSeconds = 60
)
$list = @($Commands.Split(';;', [StringSplitOptions]::RemoveEmptyEntries) | ForEach-Object { $_.Trim() } | Where-Object { $_ })
$after = $null
if ($MarkerAfter) { $after = [datetime]::Parse($MarkerAfter) }

function Pipeline-Busy {
  $procs = Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue
  foreach ($p in $procs) { if ($p.CommandLine -like '*src/cli.js*') { return $true } }
  return $false
}
function Marker-Ready {
  if (-not $MarkerFile) { return $true }
  if (-not (Test-Path $MarkerFile)) { return $false }
  if (-not $after) { return $true }
  return (Get-Item $MarkerFile).LastWriteTime -gt $after
}

Write-Output ("ожидание конвейера, старт " + (Get-Date -Format 'HH:mm'))
while ((Pipeline-Busy) -or (-not (Marker-Ready))) { Start-Sleep -Seconds $PollSeconds }
Write-Output ("конвейер свободен " + (Get-Date -Format 'HH:mm') + ", выполняю " + $list.Count + " команд")

foreach ($c in $list) {
  Write-Output ("-> " + $c + "  (" + (Get-Date -Format 'HH:mm') + ")")
  $parts = $c.Split(' ')
  if ($c.StartsWith('tools/')) { & node @parts *>> $Log }
  else { & node src/cli.js @parts *>> $Log }
  if ($LASTEXITCODE -ne 0) {
    Write-Output ("остановлено: код " + $LASTEXITCODE + " на «" + $c + "», подробности в " + $Log)
    exit $LASTEXITCODE
  }
}
Write-Output ("готово " + (Get-Date -Format 'HH:mm'))
