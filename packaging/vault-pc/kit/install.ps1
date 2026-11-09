# Forge Vault PC kit: badges on files in Explorer, and the Forge tab inside SOLIDWORKS.
#
# Builds both on this PC with the C# compiler that comes with Windows, so nothing needs
# downloading. Needs administrator rights once, to register them. Set up the sync file
# from Forge first; this kit uses the folder and key it saved.
param([switch]$Elevated, [switch]$Uninstall)
$ErrorActionPreference = 'Stop'

if (-not $Elevated) {
  $args2 = '-NoProfile -ExecutionPolicy Bypass -File "' + $PSCommandPath + '" -Elevated' + $(if ($Uninstall) { ' -Uninstall' } else { '' })
  try { Start-Process powershell.exe -Verb RunAs -ArgumentList $args2 -Wait }
  catch { Write-Host 'Administrator rights are needed to install the Forge Vault kit.'; Read-Host 'Press Enter to close' }
  exit
}

$here    = Split-Path -Parent $PSCommandPath
$target  = Join-Path $env:ProgramFiles 'Forge Vault'
$fw      = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319'
$csc     = Join-Path $fw 'csc.exe'
$regasm  = Join-Path $fw 'RegAsm.exe'
$log     = New-Object System.Collections.Generic.List[string]
function Say($text) { Write-Host $text; $log.Add($text) }

function Restart-Explorer {
  Get-Process explorer -ErrorAction SilentlyContinue | Stop-Process -Force
  Start-Sleep -Seconds 2
  if (-not (Get-Process explorer -ErrorAction SilentlyContinue)) { Start-Process explorer.exe }
}

if ($Uninstall) {
  foreach ($dll in @('ForgeVaultAddin.dll', 'ForgeVaultOverlay.dll')) {
    $path = Join-Path $target $dll
    if (Test-Path $path) { & $regasm /unregister $path | Out-Null; Say ('Removed ' + $dll) }
  }
  Restart-Explorer
  Remove-Item $target -Recurse -Force -ErrorAction SilentlyContinue
  Say 'Forge Vault kit removed. The sync and the Forge Vault folder are separate: run the sync file with -Uninstall to remove those.'
  Read-Host 'Press Enter to close'
  exit
}

try {
  if (-not (Test-Path $csc)) { throw 'The .NET Framework 4 compiler was not found. This needs Windows 10 or 11, 64-bit.' }
  if (-not (Test-Path (Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'ForgeVault\config.json'))) {
    Say 'Note: Forge Vault is not set up for this Windows user yet. Run this PC''s Forge Vault file from Forge too.'
  }

  # Unregister an older copy first, so its files can be replaced.
  foreach ($dll in @('ForgeVaultAddin.dll', 'ForgeVaultOverlay.dll')) {
    $old = Join-Path $target $dll
    if (Test-Path $old) { & $regasm /unregister $old 2>&1 | Out-Null }
  }
  Get-Process explorer -ErrorAction SilentlyContinue | Stop-Process -Force
  Start-Sleep -Seconds 1
  New-Item -ItemType Directory -Force -Path $target | Out-Null
  Copy-Item (Join-Path $here 'art\*') $target -Force
  Copy-Item (Join-Path $here '*.cs') $target -Force

  # 1. Badges in Explorer.
  Push-Location $target
  try {
    $out = & $csc /nologo /target:library /platform:anycpu /optimize+ /out:ForgeVaultOverlay.dll ForgeVaultOverlay.cs 2>&1
    if ($LASTEXITCODE -ne 0) { throw ('The badges did not build:' + [Environment]::NewLine + ($out -join [Environment]::NewLine)) }
    $out = & $regasm /codebase ForgeVaultOverlay.dll 2>&1
    if ($LASTEXITCODE -ne 0) { throw ('The badges could not be registered:' + [Environment]::NewLine + ($out -join [Environment]::NewLine)) }
    Say 'Explorer badges installed.'
  } finally { Pop-Location }
  Start-Process explorer.exe

  # 2. SOLIDWORKS add-in, for each installed SOLIDWORKS (newest wins the build).
  $sw = Get-ChildItem 'HKLM:\SOFTWARE\SolidWorks' -ErrorAction SilentlyContinue |
    Where-Object { $_.PSChildName -match '^SOLIDWORKS \d{4}$' } |
    Sort-Object PSChildName -Descending |
    ForEach-Object { (Get-ItemProperty (Join-Path $_.PSPath 'Setup') -ErrorAction SilentlyContinue).'SolidWorks Folder' } |
    Where-Object { $_ -and (Test-Path (Join-Path $_ 'api\redist\SolidWorks.Interop.sldworks.dll')) } |
    Select-Object -First 1
  if (-not $sw) {
    Say 'SOLIDWORKS was not found on this PC, so the Forge tab was not added. The badges and the right-click menu still work.'
  } else {
    $redist = Join-Path $sw 'api\redist'
    foreach ($name in @('SolidWorks.Interop.sldworks.dll', 'SolidWorks.Interop.swconst.dll', 'SolidWorks.Interop.swpublished.dll')) {
      Copy-Item (Join-Path $redist $name) $target -Force
    }
    Push-Location $target
    try {
      $refs = @('System.dll', 'System.Core.dll', 'System.Drawing.dll', 'System.Windows.Forms.dll', 'System.Net.Http.dll', 'System.Web.Extensions.dll', 'Microsoft.CSharp.dll',
        'SolidWorks.Interop.sldworks.dll', 'SolidWorks.Interop.swconst.dll', 'SolidWorks.Interop.swpublished.dll') | ForEach-Object { '/reference:' + $_ }
      $out = & $csc /nologo /target:library /platform:x64 /optimize+ /out:ForgeVaultAddin.dll @refs ForgeVaultAddin.cs 2>&1
      if ($LASTEXITCODE -ne 0) { throw ('The SOLIDWORKS add-in did not build:' + [Environment]::NewLine + ($out -join [Environment]::NewLine)) }
      $out = & $regasm /codebase ForgeVaultAddin.dll 2>&1
      if ($LASTEXITCODE -ne 0) { throw ('The SOLIDWORKS add-in could not be registered:' + [Environment]::NewLine + ($out -join [Environment]::NewLine)) }
      Say ('SOLIDWORKS add-in installed (built against ' + $sw + '). Start SOLIDWORKS: look for the Forge tab, and Forge Vault in the Task Pane.')
      Say 'If the tab is missing: Tools > Add-Ins, tick Forge Vault in both columns.'
    } finally { Pop-Location }
  }
  Say ''
  Say 'Done. Files in the Forge Vault folder now show a green pencil (locked by you), a red lock (locked by someone else) or a blue tick (released).'
} catch {
  Say ''
  Say ('Something went wrong: ' + $_.Exception.Message)
  if (-not (Get-Process explorer -ErrorAction SilentlyContinue)) { Start-Process explorer.exe }
}
$log | Set-Content -Path (Join-Path $env:TEMP 'ForgeVault-kit-install.log') -Encoding UTF8
Read-Host 'Press Enter to close'
