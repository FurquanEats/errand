# Builds Errand.exe (scripts/windows/Errand.cs) with the C# compiler that comes with Windows.
# The installer runs this on your computer; the release workflow runs it to make Errand-Setup.exe.
#
#   powershell -File scripts/windows/build.ps1 -Out Errand.exe
param([Parameter(Mandatory = $true)][string]$Out, [string]$Version)

$ErrorActionPreference = 'Stop'
$repo = Resolve-Path (Join-Path $PSScriptRoot '..\..')
if (-not $Version) { $Version = (Get-Content (Join-Path $repo 'package.json') -Raw | ConvertFrom-Json).version }
$fw = if ([Environment]::Is64BitOperatingSystem) { 'Framework64' } else { 'Framework' }
$csc = Join-Path $env:WINDIR "Microsoft.NET\$fw\v4.0.30319\csc.exe"
if (-not (Test-Path $csc)) { throw 'The C# compiler that comes with Windows (.NET Framework 4) was not found.' }

# Windows file versions are four numbers; "0.3.0-beta" becomes 0.3.0.0.
$num = ($Version -replace '[^0-9.].*$', '').TrimEnd('.')
while (($num -split '\.').Count -lt 4) { $num += '.0' }
$tmp = Join-Path ([IO.Path]::GetTempPath()) "errand-build-$([guid]::NewGuid())"
New-Item -ItemType Directory -Force $tmp | Out-Null
try {
  $info = Join-Path $tmp 'Version.cs'
  @(
    "[assembly: System.Reflection.AssemblyVersion(""$num"")]"
    "[assembly: System.Reflection.AssemblyFileVersion(""$num"")]"
    "[assembly: System.Reflection.AssemblyInformationalVersion(""$Version"")]"
  ) | Set-Content $info -Encoding ASCII
  $here = $PSScriptRoot
  $icon = Join-Path $repo 'web\public\icon.ico'
  $installer = Join-Path $repo 'scripts\install.ps1'
  $outPath = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($Out)
  & $csc /nologo /target:winexe /optimize+ /codepage:65001 /utf8output "/out:$outPath" "/win32icon:$icon" "/win32manifest:$here\Errand.manifest" `
    "/resource:$installer,install.ps1" "/resource:$icon,icon.ico" /reference:System.Windows.Forms.dll /reference:System.Drawing.dll /reference:System.Web.Extensions.dll `
    "$here\Errand.cs" $info
  if ($LASTEXITCODE -ne 0) { throw 'Building Errand.exe failed.' }
} finally {
  Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
}
