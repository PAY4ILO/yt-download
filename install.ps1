# Sets up YT Download on this PC: installs missing Python/yt-dlp, Node.js, ffmpeg (winget),
# registers the native host for Edge/Chrome/Firefox and the daily yt-dlp update task.
# Run: double-click install.cmd. Safe to run again.
param([switch]$Quiet)  # -Quiet: rerun after a self-update, no prompts, no new installs
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$hostDir = Join-Path $root 'host'
$hostName = 'yt_download_host'
$extId = 'yt-download@payk'
$chromiumId = 'ajdmmfhbokpfeeceanpacfjfalcidddm'
$taskName = 'YtDownload-Update'

function Find-Exe($name) { $c = Get-Command $name -ErrorAction SilentlyContinue; if ($c) { $c.Source } }
function Refresh-Path { $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User') }

# A real Python (the WindowsApps "python" stub only opens the Store, so it fails this test).
function Find-Python {
    $cands = @((Find-Exe 'py'), (Find-Exe 'python')) + (Get-ChildItem "$env:LOCALAPPDATA\Programs\Python\Python3*\python.exe" -ErrorAction SilentlyContinue | ForEach-Object FullName)
    foreach ($c in $cands) {
        if (-not $c) { continue }
        try { $p = & $c -c "import sys;print(sys.executable)" 2>$null } catch { $p = $null }
        if ($LASTEXITCODE -eq 0 -and $p) { return $p.Trim() }
    }
}
function Find-Ffmpeg {
    $f = Find-Exe 'ffmpeg'
    if (-not $f) { $f = Get-ChildItem "$env:LOCALAPPDATA\Microsoft\WinGet\Packages\Gyan.FFmpeg*\*\bin\ffmpeg.exe" -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty FullName }
    if (-not $f) { return $null }
    $real = (Get-Item $f).Target   # WinGet puts a link into Links\, yt-dlp wants the real bin folder
    if ($real) { $f = $real | Select-Object -First 1 }
    Split-Path $f
}

$python = Find-Python
$node = Find-Exe 'node'
$ffmpegDir = Find-Ffmpeg

$missing = @()
if (-not $python) { $missing += [pscustomobject]@{ Name = 'Python 3'; Id = 'Python.Python.3.13' } }
if (-not $node) { $missing += [pscustomobject]@{ Name = 'Node.js'; Id = 'OpenJS.NodeJS.LTS' } }
if (-not $ffmpegDir) { $missing += [pscustomobject]@{ Name = 'ffmpeg'; Id = 'Gyan.FFmpeg' } }
if ($missing -and -not $Quiet) {
    Write-Host ('Не хватает: ' + (($missing | ForEach-Object Name) -join ', ')) -ForegroundColor Yellow
    if (-not (Find-Exe 'winget')) { throw 'Нет winget. Поставь «Установщик приложений» из Microsoft Store или эти программы вручную.' }
    $ans = Read-Host 'Установить через winget? [Y/n]'
    if ($ans -match '^(n|н)') { throw 'Без них расширение работать не будет.' }
    foreach ($m in $missing) {
        Write-Host "Ставлю $($m.Name)..."
        winget install -e --id $m.Id --scope user --accept-package-agreements --accept-source-agreements
        if ($LASTEXITCODE -ne 0) { winget install -e --id $m.Id --accept-package-agreements --accept-source-agreements }
    }
    Refresh-Path
    $python = Find-Python; $node = Find-Exe 'node'; $ffmpegDir = Find-Ffmpeg
}
if (-not $python) { throw 'Python не найден. Если только что поставился — закрой окно и запусти install.cmd ещё раз.' }
if (-not $node) { throw 'Node.js не найден. Если только что поставился — закрой окно и запусти install.cmd ещё раз.' }
if (-not $ffmpegDir) { Write-Warning 'ffmpeg не найден: видео выше 360p и MP3 работать не будут.'; $ffmpegDir = '' }

& $python -c "import yt_dlp" 2>$null
if ($LASTEXITCODE -ne 0) {
    Write-Host 'Ставлю yt-dlp...'
    & $python -m pip install -U --disable-pip-version-check "yt-dlp[default]"
    if ($LASTEXITCODE -ne 0) { throw 'Не удалось поставить yt-dlp через pip.' }
}
$pythonw = Join-Path (Split-Path $python) 'pythonw.exe'
if (-not (Test-Path $pythonw)) { $pythonw = $python }

# Firefox profile for cookies (age-restricted / "not a bot" videos). Store build keeps it under Packages.
$ffProfile = $null
$roots = @(Get-ChildItem "$env:LOCALAPPDATA\Packages" -Directory -Filter 'Mozilla.Firefox_*' -ErrorAction SilentlyContinue |
    ForEach-Object { Join-Path $_.FullName 'LocalCache\Roaming\Mozilla\Firefox\Profiles' }) + "$env:APPDATA\Mozilla\Firefox\Profiles"
foreach ($r in $roots) {
    if (-not (Test-Path $r)) { continue }
    $p = Get-ChildItem $r -Directory | Where-Object { Test-Path (Join-Path $_.FullName 'cookies.sqlite') } |
        Sort-Object { (Get-Item (Join-Path $_.FullName 'cookies.sqlite')).LastWriteTime } -Descending | Select-Object -First 1
    if ($p) { $ffProfile = $p.FullName; break }
}

$downloads = (New-Object -ComObject Shell.Application).NameSpace('shell:Downloads').Self.Path
$defaultDir = Join-Path $downloads 'YouTube'

$config = [ordered]@{
    python = $python
    node = $node
    ffmpeg = $ffmpegDir
    firefoxProfile = $ffProfile
    defaultDir = $defaultDir
    updateTask = $taskName
}
$utf8 = New-Object System.Text.UTF8Encoding($false)
[IO.File]::WriteAllText((Join-Path $hostDir 'config.json'), ($config | ConvertTo-Json), $utf8)

$bat = Join-Path $hostDir 'host.bat'
[IO.File]::WriteAllText($bat, "@echo off`r`n`"$node`" `"%~dp0host.js`" %*`r`n", $utf8)

$manifestPath = Join-Path $hostDir "$hostName.json"
$manifest = [ordered]@{
    name = $hostName
    description = 'YT Download: yt-dlp bridge'
    path = $bat
    type = 'stdio'
    allowed_extensions = @($extId)
}
[IO.File]::WriteAllText($manifestPath, ($manifest | ConvertTo-Json), $utf8)

$key = "HKCU:\Software\Mozilla\NativeMessagingHosts\$hostName"
New-Item -Path $key -Force | Out-Null
Set-ItemProperty -Path $key -Name '(default)' -Value $manifestPath

# Edge / Chrome: same host, but they identify the extension by origin. The ID is fixed by "key" in manifest.json.
$chromiumManifestPath = Join-Path $hostDir "$hostName.chromium.json"
$chromiumManifest = [ordered]@{
    name = $hostName
    description = 'YT Download: yt-dlp bridge'
    path = $bat
    type = 'stdio'
    allowed_origins = @("chrome-extension://$chromiumId/")
}
[IO.File]::WriteAllText($chromiumManifestPath, ($chromiumManifest | ConvertTo-Json), $utf8)
foreach ($k in "HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\$hostName", "HKCU:\Software\Google\Chrome\NativeMessagingHosts\$hostName") {
    New-Item -Path $k -Force | Out-Null
    Set-ItemProperty -Path $k -Name '(default)' -Value $chromiumManifestPath
}

# Daily yt-dlp update (YouTube changes often, old yt-dlp starts getting 403s).
$action = New-ScheduledTaskAction -Execute $pythonw -Argument '-m pip install -U --quiet --disable-pip-version-check "yt-dlp[default]"'
$trigger = New-ScheduledTaskTrigger -Daily -At 12:00
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 10)
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Description 'Обновляет yt-dlp для расширения YT Download' -Force | Out-Null

Write-Host ''
Write-Host 'Готово.' -ForegroundColor Green
Write-Host "  Python + yt-dlp: $python"
Write-Host "  Node:            $node"
Write-Host "  ffmpeg:          $ffmpegDir"
Write-Host "  Профиль Firefox: $ffProfile"
Write-Host "  Папка загрузок:  $defaultDir"
