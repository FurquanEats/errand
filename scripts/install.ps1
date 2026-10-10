# Errand installer for Windows. No admin rights, no Git, no coding.
#
#   irm https://raw.githubusercontent.com/FurquanEats/errand/main/scripts/install.ps1 | iex
#
# Installs into %LOCALAPPDATA%\Errand (app, a private copy of Node.js if needed, and your data),
# adds Errand to the Desktop and Start menu, and opens it. Run it again any time to update;
# your data is kept. Optional: set ERRAND_HOME to install elsewhere, ERRAND_PORT to use another port.

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$Repo = 'FurquanEats/errand'
$Root = if ($env:ERRAND_HOME) { $env:ERRAND_HOME } else { Join-Path $env:LOCALAPPDATA 'Errand' }
$Port = if ($env:ERRAND_PORT) { $env:ERRAND_PORT } else { '4747' }
$AppDir = Join-Path $Root 'app'
$DataDir = Join-Path $Root 'data'
$NodeDir = Join-Path $Root 'node'
$MinNode = [version]'22.13.0'

function Step($text) { Write-Host "`n  $text" -ForegroundColor White }
function Info($text) { Write-Host "    $text" -ForegroundColor DarkGray }

try {
  Write-Host "`n  Errand setup" -ForegroundColor White
  Info "Installing to $Root"
  Info "Errand runs on this computer and sends nothing to us. What it sends where: https://github.com/FurquanEats/errand/blob/main/PRIVACY.md"
  New-Item -ItemType Directory -Force -Path $Root, $DataDir | Out-Null
  # Errand runs in the background; quit it so its files can be updated.
  $status = "http://127.0.0.1:$Port/api/status"
  try {
    Invoke-WebRequest $status -UseBasicParsing -TimeoutSec 2 | Out-Null
    Info 'Closing Errand to update it'
    try { Invoke-WebRequest "http://127.0.0.1:$Port/api/quit" -Method Post -Headers @{ 'X-Errand' = '1' } -UseBasicParsing -TimeoutSec 5 | Out-Null } catch { }
    Start-Sleep 3
    try {
      Invoke-WebRequest $status -UseBasicParsing -TimeoutSec 2 | Out-Null
      throw 'Errand is still running. Close its console window first, then run setup again to update.'
    } catch [System.Net.WebException] { }
  } catch [System.Net.WebException] { }
  # Errand.exe (the icon by the clock) leaves once Errand stops; wait so it can be replaced.
  $exe = Join-Path $Root 'Errand.exe'
  for ($i = 0; $i -lt 20 -and (Get-Process Errand -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $exe }); $i++) { Start-Sleep -Milliseconds 500 }
  Get-Process Errand -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $exe } | Stop-Process -Force -ErrorAction SilentlyContinue

  # ── Node.js ──────────────────────────────────────────────────────────────
  Step 'Checking Node.js'
  $node = $null
  $sys = Get-Command node -ErrorAction SilentlyContinue
  if ($sys) {
    $v = (& $sys.Source -v) -replace '^v', ''
    if ([version]$v -ge $MinNode) { $node = $sys.Source; Info "Using installed Node.js $v" }
  }
  if (-not $node -and (Test-Path (Join-Path $NodeDir 'node.exe'))) {
    $v = (& (Join-Path $NodeDir 'node.exe') -v) -replace '^v', ''
    if ([version]$v -ge $MinNode) { $node = Join-Path $NodeDir 'node.exe'; Info "Using Errand's Node.js $v" }
  }
  if (-not $node) {
    $arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'arm64' } else { 'x64' }
    $release = (Invoke-RestMethod 'https://nodejs.org/dist/index.json') |
      Where-Object { $_.lts -and $_.files -contains "win-$arch-zip" -and [version]($_.version -replace '^v', '') -ge $MinNode } |
      Select-Object -First 1
    if (-not $release) { throw 'Could not find a Node.js release to download.' }
    $ver = $release.version
    $name = "node-$ver-win-$arch"
    Info "Downloading Node.js $ver (private copy, about 30 MB)"
    $zip = Join-Path $env:TEMP "$name.zip"
    Invoke-WebRequest "https://nodejs.org/dist/$ver/$name.zip" -OutFile $zip -UseBasicParsing
    # Verify the download against Node's published checksums.
    $sums = (Invoke-WebRequest "https://nodejs.org/dist/$ver/SHASUMS256.txt" -UseBasicParsing).Content
    $expected = ($sums -split "`n" | Where-Object { $_ -match " $name\.zip$" }) -replace '\s.*$', ''
    $actual = (Get-FileHash $zip -Algorithm SHA256).Hash.ToLower()
    if (-not $expected -or $actual -ne $expected.Trim().ToLower()) { throw 'Node.js download failed its checksum. Please try again.' }
    $tmp = Join-Path $env:TEMP "errand-node-$([guid]::NewGuid())"
    Expand-Archive $zip -DestinationPath $tmp -Force
    if (Test-Path $NodeDir) { Remove-Item $NodeDir -Recurse -Force }
    Move-Item (Join-Path $tmp $name) $NodeDir
    Remove-Item $zip, $tmp -Recurse -Force -ErrorAction SilentlyContinue
    $node = Join-Path $NodeDir 'node.exe'
  }
  $nodeBin = Split-Path $node
  $npm = Join-Path $nodeBin 'npm.cmd'
  $env:Path = "$nodeBin;$env:Path"

  # ── Errand ───────────────────────────────────────────────────────────────
  Step 'Downloading Errand'
  # The latest release; falls back to the main branch before the first release exists.
  # ERRAND_REF installs a specific branch, tag or commit instead (used by CI).
  $ref = if ($env:ERRAND_REF) { $env:ERRAND_REF } else { 'refs/heads/main' }
  if (-not $env:ERRAND_REF) {
    try {
      $tag = (Invoke-RestMethod "https://api.github.com/repos/$Repo/releases/latest").tag_name
      if ($tag) { $ref = "refs/tags/$tag"; Info "Version $tag" }
    } catch { }
  }
  $zip = Join-Path $env:TEMP 'errand.zip'
  Invoke-WebRequest "https://github.com/$Repo/archive/$ref.zip" -OutFile $zip -UseBasicParsing
  $tmp = Join-Path $env:TEMP "errand-app-$([guid]::NewGuid())"
  Expand-Archive $zip -DestinationPath $tmp -Force
  if (Test-Path $AppDir) { Remove-Item $AppDir -Recurse -Force }
  Move-Item (Get-ChildItem $tmp -Directory | Select-Object -First 1).FullName $AppDir
  Remove-Item $zip, $tmp -Recurse -Force -ErrorAction SilentlyContinue

  Step 'Setting it up (a minute or two)'
  Push-Location $AppDir
  try {
    & $npm install --no-audit --no-fund --loglevel=error
    if ($LASTEXITCODE -ne 0) { throw 'Installing dependencies failed.' }
    & $npm run build --silent
    if ($LASTEXITCODE -ne 0) { throw 'Building the app failed.' }
  } finally { Pop-Location }

  # ── Launcher and shortcuts ───────────────────────────────────────────────
  Step 'Adding Errand to your Desktop and Start menu'
  $launcher = Join-Path $Root 'Errand.cmd'
  @"
@echo off
title Errand
set "ERRAND_DATA_DIR=$DataDir"
set "ERRAND_PORT=$Port"
set "PATH=$nodeBin;%PATH%"
set "ERRAND_OPEN=1"
cd /d "$AppDir"
echo.
echo   Errand is starting. It opens in its own window in a moment.
echo.
"$node" --disable-warning=ExperimentalWarning --import tsx server/index.ts
"@ | Set-Content -Path $launcher -Encoding ASCII

  @(
    "node=$node"
    "port=$Port"
  ) | Set-Content -Path (Join-Path $Root 'errand.ini') -Encoding UTF8

  # Errand.exe is the app you click: it runs Errand in the background with an icon by the clock,
  # and clicking it again just reopens the window. It is built here from the source just downloaded,
  # with the C# compiler that comes with Windows, or copied from a signed Errand-Setup.exe of the
  # same version.
  $version = (Get-Content (Join-Path $AppDir 'package.json') -Raw | ConvertFrom-Json).version
  $built = $false
  try {
    $setup = $env:ERRAND_SETUP_EXE
    if ($setup -and (Test-Path $setup) -and $setup -ne $exe -and
        (Get-Item $setup).VersionInfo.ProductVersion -eq $version -and
        (Get-AuthenticodeSignature $setup).Status -eq 'Valid') {
      Copy-Item $setup "$exe.new" -Force
    } else {
      & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $AppDir 'scripts\windows\build.ps1') -Out "$exe.new" | Out-Null
      if ($LASTEXITCODE -ne 0) { throw 'build failed' }
    }
    Move-Item "$exe.new" $exe -Force
    $built = $true
  } catch {
    Info 'Could not build Errand.exe; using a simpler launcher instead.'
    Remove-Item "$exe.new" -Force -ErrorAction SilentlyContinue
  }

  $icon = Join-Path $Root 'Errand.ico'
  Copy-Item (Join-Path $AppDir 'web\public\icon.ico') $icon -Force
  $log = Join-Path $Root 'errand.log'
  $vbs = Join-Path $Root 'Errand.vbs'
  $wscript = Join-Path $env:SystemRoot 'System32\wscript.exe'
  $hidden = -not $built -and (Test-Path $wscript) -and (Test-Path (Join-Path $env:SystemRoot 'System32\vbscript.dll'))
  if ($hidden) {
    # Fallback: start Errand quietly in the background without a console window.
    @'
' Starts Errand in the background without a console window. Its output goes to errand.log.
CreateObject("WScript.Shell").Run "cmd /c """"LAUNCHER"" > ""LOG"" 2>&1""", 0, False
'@.Replace('LAUNCHER', $launcher).Replace('LOG', $log) | Set-Content -Path "$vbs.new" -Encoding ASCII
    # Swap it in whole, so the icon never finds it missing or half-written mid-update.
    Move-Item "$vbs.new" $vbs -Force
  } elseif ($built) {
    Remove-Item $vbs -Force -ErrorAction SilentlyContinue
  }

  $shell = New-Object -ComObject WScript.Shell
  foreach ($dir in @([Environment]::GetFolderPath('Desktop'), (Join-Path ([Environment]::GetFolderPath('StartMenu')) 'Programs'))) {
    $lnk = $shell.CreateShortcut((Join-Path $dir 'Errand.lnk'))
    $lnk.Arguments = ''
    if ($built) {
      $lnk.TargetPath = $exe
      $lnk.IconLocation = "$exe,0"
    } elseif ($hidden) {
      $lnk.TargetPath = $wscript
      $lnk.Arguments = "`"$vbs`""
      $lnk.IconLocation = "$icon,0"
    } else {
      $lnk.TargetPath = $launcher
      $lnk.WindowStyle = 7
      $lnk.IconLocation = "$icon,0"
    }
    $lnk.WorkingDirectory = $Root
    $lnk.Description = 'Errand, your personal AI agent'
    $lnk.Save()
  }

  # Listed in Settings > Apps > Installed apps, with an Uninstall button (no admin rights needed).
  if ($built) {
    $key = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\Errand'
    New-Item -Path $key -Force | Out-Null
    $size = [int]((Get-ChildItem $Root -Recurse -File -ErrorAction SilentlyContinue | Where-Object { $_.FullName -notlike "$DataDir\*" } | Measure-Object Length -Sum).Sum / 1KB)
    @{
      DisplayName = 'Errand'; DisplayVersion = $version; Publisher = 'Zovle'; DisplayIcon = "$exe,0"
      InstallLocation = $Root; UninstallString = "`"$exe`" --uninstall"; QuietUninstallString = "`"$exe`" --uninstall --quiet"
      URLInfoAbout = "https://github.com/$Repo"; HelpLink = "https://github.com/$Repo/issues"
    }.GetEnumerator() | ForEach-Object { Set-ItemProperty -Path $key -Name $_.Key -Value $_.Value }
    foreach ($flag in 'NoModify', 'NoRepair') { New-ItemProperty -Path $key -Name $flag -Value 1 -PropertyType DWord -Force | Out-Null }
    New-ItemProperty -Path $key -Name EstimatedSize -Value $size -PropertyType DWord -Force | Out-Null
  }

  Write-Host "`n  Done. Errand is opening." -ForegroundColor Green
  Info 'Next time, open it from the Errand icon on your Desktop or Start menu.'
  Info 'It keeps running in the background, with an icon by the clock. To stop it, choose Quit Errand there or in its menu.'
  if ($built) { Start-Process $exe } elseif ($hidden) { Start-Process $wscript "`"$vbs`"" } else { Start-Process $launcher -WindowStyle Minimized }
} catch {
  Write-Host "`n  Setup stopped: $($_.Exception.Message)" -ForegroundColor Red
  # Started from Errand-Setup.exe: keep the window open so the message can be read.
  if ($env:ERRAND_SETUP_PAUSE) { Read-Host '  Press Enter to close' | Out-Null; exit 1 }
  # Started from Errand-Setup-Windows.cmd: report failure so the window stays open to read.
  if ($env:ERRAND_SETUP_WRAPPER) { exit 1 }
}
