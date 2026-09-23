# Ждёт, пока не останется ни одного запущенного этапа конвейера, и выполняет переданные
# команды по очереди. Нужен для правила «хвост после длинного процесса запускается сам».
#
# Почему не сторожить PID: этап конвейера — это отдельный процесс node на каждую стадию.
# Когда keyword-serp заканчивается и начинается enrich-apps, PID меняется, и сторож по
# одному PID решает, что всё кончилось, — 23.09 из-за этого пересчёт стартовал на середине
# сбора и ниши США остались на старых ключах. Поэтому проверяется не PID, а наличие любого
# node с src/cli.js в командной строке.
#
# Команды передаются одной строкой через «;;» — при запуске через -File PowerShell не умеет
# принимать массив: второй элемент уезжает в следующий позиционный параметр.
#
#   powershell -File tools/wait-and-run.ps1 -Log logs/tail.log -Commands "stage score --geo US;;stage radar-v2 --geo US,GB"
param(
  [string]$Log = 'logs/wait-and-run.log',
  [string]$Commands = '',
  [int]$PollSeconds = 60
)
$list = @($Commands.Split(';;', [StringSplitOptions]::RemoveEmptyEntries) | ForEach-Object { $_.Trim() } | Where-Object { $_ })

function Pipeline-Busy {
  $procs = Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue
  foreach ($p in $procs) { if ($p.CommandLine -like '*src/cli.js*') { return $true } }
  return $false
}

Write-Output ("ожидание конвейера, старт " + (Get-Date -Format 'HH:mm'))
while (Pipeline-Busy) { Start-Sleep -Seconds $PollSeconds }
Write-Output ("конвейер свободен " + (Get-Date -Format 'HH:mm') + ", выполняю " + $list.Count + " команд")

foreach ($c in $list) {
  Write-Output ("-> node src/cli.js " + $c + "  (" + (Get-Date -Format 'HH:mm') + ")")
  $args = $c.Split(' ')
  & node src/cli.js @args *>> $Log
  if ($LASTEXITCODE -ne 0) {
    Write-Output ("остановлено: код " + $LASTEXITCODE + " на «" + $c + "», подробности в " + $Log)
    exit $LASTEXITCODE
  }
}
Write-Output ("готово " + (Get-Date -Format 'HH:mm'))
