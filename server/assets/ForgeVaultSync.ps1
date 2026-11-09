# Forge Vault for __PC_NAME__
#
# Puts a "Forge Vault" folder at the top of File Explorer's left panel, like a PDM vault, so
# it is also in SOLIDWORKS and AutoCAD Open and Save windows. Nothing moves by itself, like
# git: you PULL to get files from Forge and PUSH to send your changes with a message.
#   - Right-click a file or folder in Forge Vault > Forge vault > Pull, Push, Lock, ...
#   - Or use the Forge Vault icon by the clock.
# Forge decides what this PC's person may pull and push. A push that started from an older
# version than the vault has is turned away: pull first, so nobody overwrites anybody.
#
# Set up:     right-click this file > Run with PowerShell. Nothing else to install.
# Switch off: run it again with -Uninstall.
param([switch]$Tray, [switch]$Uninstall, [string]$Action = '', [string]$Target = '')

$ErrorActionPreference = 'Stop'
$ForgeUrl = '__FORGE_URL__'
$AgentKey = '__AGENT_KEY__'
$Folder   = [Environment]::ExpandEnvironmentVariables('__PC_FOLDER__').TrimEnd('\')
$PcName   = '__PC_NAME__'
$Types    = @(__TYPES__)
$IconB64  = '__ICON_B64__'

$Home2      = Join-Path $env:LOCALAPPDATA 'ForgeVault'
$Self       = Join-Path $Home2 'ForgeVault.ps1'
$StateFile  = Join-Path $Home2 'state.json'
$StatusFile = Join-Path $Home2 'status.txt'
$ConfigFile = Join-Path $Home2 'config.json'
$LogFile    = Join-Path $Home2 'forge-vault.log'
$IconFile   = Join-Path $Home2 'forge-vault.ico'
$SetAside   = Join-Path $Home2 'Set aside'
$Startup    = Join-Path ([Environment]::GetFolderPath('Startup')) 'Forge Vault.vbs'
$FileMenu   = 'HKCU:\Software\Classes\*\shell\ForgeVault'
$FolderMenu = 'HKCU:\Software\Classes\Directory\shell\ForgeVault'

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Net.Http
[System.Windows.Forms.Application]::EnableVisualStyles()

function Say($text) {
  $line = (Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + '  ' + $text
  try {
    if ((Test-Path $LogFile) -and (Get-Item $LogFile).Length -gt 2MB) { Move-Item $LogFile ($LogFile + '.old') -Force }
    Add-Content -Path $LogFile -Value $line -Encoding UTF8
  } catch {}
}
function Show($text, $icon = 'Information') { [System.Windows.Forms.MessageBox]::Show($text, 'Forge Vault', 'OK', $icon) | Out-Null }
function Ask-Yes($text) { ([System.Windows.Forms.MessageBox]::Show($text, 'Forge Vault', 'YesNo', 'Question')) -eq 'Yes' }

if (-not ('ForgeShell' -as [type])) {
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class ForgeShell {
  [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
  static extern void SHChangeNotify(int eventId, uint flags, string item1, IntPtr item2);
  // Tells Explorer a file changed, so its badge is drawn again.
  public static void Updated(string path) { SHChangeNotify(0x00002000, 0x0005, path, IntPtr.Zero); }
  public static void Everything() { SHChangeNotify(0x08000000, 0x0000, null, IntPtr.Zero); }
}
'@
}

# ---------- Setting up and switching off ----------
$NavId = $null
if (Test-Path $ConfigFile) { try { $NavId = (Get-Content $ConfigFile -Raw | ConvertFrom-Json).navId } catch {} }
if (-not $NavId) { $NavId = '{' + [guid]::NewGuid().ToString().ToUpper() + '}' }

function Write-Config {
  New-Item -ItemType Directory -Force -Path $Home2 | Out-Null
  # Read by the Explorer badges and the SOLIDWORKS add-in.
  @{ url = $ForgeUrl; key = $AgentKey; root = $Folder; pc = $PcName; status = $StatusFile; navId = $NavId; script = $Self } |
    ConvertTo-Json | Set-Content -Path $ConfigFile -Encoding UTF8
}

function Set-Reg($path, $name, $value, $type = 'String') {
  if (-not (Test-Path $path)) { New-Item -Path $path -Force | Out-Null }
  if ($name -eq '(default)') { Set-Item -Path $path -Value $value }
  else { New-ItemProperty -Path $path -Name $name -Value $value -PropertyType $type -Force | Out-Null }
}

# The folder at the top of Explorer's left panel, the way cloud drives add theirs.
function Add-NavigationPane {
  foreach ($root in @('HKCU:\Software\Classes\CLSID', 'HKCU:\Software\Classes\Wow6432Node\CLSID')) {
    $k = Join-Path $root $NavId
    Set-Reg $k '(default)' 'Forge Vault'
    Set-Reg $k 'System.IsPinnedToNameSpaceTree' 1 'DWord'
    Set-Reg $k 'SortOrderIndex' 0x41 'DWord'
    Set-Reg "$k\DefaultIcon" '(default)' "$IconFile,0"
    Set-Reg "$k\InProcServer32" '(default)' '%SYSTEMROOT%\system32\shell32.dll' 'ExpandString'
    Set-Reg "$k\Instance" 'CLSID' '{0E5AAE11-A475-4c5b-AB00-C66DE400274E}'
    Set-Reg "$k\Instance\InitPropertyBag" 'Attributes' 0x11 'DWord'
    Set-Reg "$k\Instance\InitPropertyBag" 'TargetFolderPath' $Folder 'ExpandString'
    Set-Reg "$k\ShellFolder" 'FolderValueFlags' 0x28 'DWord'
    Set-Reg "$k\ShellFolder" 'Attributes' ([int]-260046771) 'DWord'
  }
  Set-Reg "HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\Desktop\NameSpace\$NavId" '(default)' 'Forge Vault'
  Set-Reg 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\HideDesktopIcons\NewStartPanel' $NavId 1 'DWord'
}

function Remove-NavigationPane {
  foreach ($k in @("HKCU:\Software\Classes\CLSID\$NavId", "HKCU:\Software\Classes\Wow6432Node\CLSID\$NavId", "HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\Desktop\NameSpace\$NavId")) {
    if (Test-Path $k) { Remove-Item $k -Recurse -Force }
  }
  Remove-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\HideDesktopIcons\NewStartPanel' -Name $NavId -ErrorAction SilentlyContinue
}

function Add-Menu($key, $items) {
  if (Test-Path $key) { Remove-Item $key -Recurse -Force }
  Set-Reg $key 'MUIVerb' 'Forge vault'
  Set-Reg $key 'Icon' "$IconFile,0"
  Set-Reg $key 'SubCommands' ''
  Set-Reg $key 'AppliesTo' ('System.ItemPathDisplay:~<"' + $Folder + '"')
  foreach ($m in $items) {
    $k = "$key\shell\" + $m[0] + '_' + $m[1]
    Set-Reg $k 'MUIVerb' $m[2]
    Set-Reg "$k\command" '(default)' ('powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $Self + '" -Action ' + $m[1] + ' -Target "%1"')
  }
}

function Set-FolderLook {
  New-Item -ItemType Directory -Force -Path $Folder | Out-Null
  $ini = Join-Path $Folder 'desktop.ini'
  if (Test-Path $ini) { (Get-Item $ini -Force).Attributes = 'Normal' }
  Set-Content -Path $ini -Encoding Unicode -Value @('[.ShellClassInfo]', "IconResource=$IconFile,0", 'InfoTip=Forge drawing vault. Pull to get files, push to send changes.')
  (Get-Item $ini -Force).Attributes = 'Hidden, System'
  (Get-Item $Folder -Force).Attributes = 'ReadOnly, Directory'
}

function Stop-Tray {
  Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" |
    Where-Object { $_.CommandLine -like '*ForgeVault.ps1*-Tray*' -and $_.ProcessId -ne $PID } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
}

if ($Uninstall) {
  Stop-Tray
  Remove-Item $Startup -ErrorAction SilentlyContinue
  foreach ($k in @($FileMenu, $FolderMenu)) { if (Test-Path $k) { Remove-Item $k -Recurse -Force } }
  Remove-NavigationPane
  if (Test-Path $Folder) { Get-ChildItem $Folder -Recurse -File -Force | Where-Object { $_.IsReadOnly } | ForEach-Object { $_.IsReadOnly = $false } }
  Remove-Item $StatusFile -ErrorAction SilentlyContinue
  [ForgeShell]::Everything()
  Show ('Forge Vault is switched off on this PC. Your files are still in ' + $Folder + '.')
  exit
}

if (-not $Tray -and -not $Action) {
  New-Item -ItemType Directory -Force -Path $Home2, $SetAside | Out-Null
  if ($PSCommandPath -ne $Self) { Copy-Item -Path $PSCommandPath -Destination $Self -Force }
  [IO.File]::WriteAllBytes($IconFile, [Convert]::FromBase64String($IconB64))
  Write-Config
  Set-FolderLook
  Add-NavigationPane
  Add-Menu $FileMenu @(
    @('a', 'pull', 'Pull latest'), @('b', 'push', 'Push...'), @('c', 'lock', 'Lock (I am changing it)'), @('d', 'unlock', 'Unlock'),
    @('e', 'submit', 'Send for review'), @('f', 'release', 'Approve and release'), @('g', 'reject', 'Send back'),
    @('h', 'newrev', 'Start new revision'), @('i', 'open', 'Show in Forge'))
  Add-Menu $FolderMenu @(@('a', 'pullall', 'Pull...'), @('b', 'pushall', 'Push...'))
  Stop-Tray
  $command = 'powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $Self + '" -Tray'
  Set-Content -Path $Startup -Encoding ASCII -Value ('CreateObject("WScript.Shell").Run "' + $command.Replace('"', '""') + '", 0, False')
  Start-Process -FilePath 'wscript.exe' -ArgumentList ('"' + $Startup + '"')
  [ForgeShell]::Everything()
  Show ('Forge Vault is set up.' + [Environment]::NewLine + [Environment]::NewLine +
    'Look for Forge Vault at the top of File Explorer''s left panel, and in SOLIDWORKS File > Open.' + [Environment]::NewLine +
    'Nothing is copied by itself. Right-click the Forge Vault folder > Forge vault > Pull to get your files, or use the Forge Vault icon by the clock.' + [Environment]::NewLine + [Environment]::NewLine +
    'For badges on files and the Forge tab in SOLIDWORKS, also run the PC kit.')
  exit
}

# ---------- Talking to Forge ----------
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$client = New-Object System.Net.Http.HttpClient
$client.Timeout = [TimeSpan]::FromMinutes(30)
$client.DefaultRequestHeaders.Add('x-forge-agent-key', $AgentKey)

function Read-Answer($response) {
  $body = $response.Content.ReadAsStringAsync().Result
  $parsed = $null
  try { $parsed = $body | ConvertFrom-Json } catch {}
  if ($response.IsSuccessStatusCode) { return $parsed.data }
  $message = if ($parsed -and $parsed.error) { $parsed.error.message } else { 'Forge answered ' + [int]$response.StatusCode }
  $err = New-Object Exception $message
  $err.Data['status'] = [int]$response.StatusCode
  $err.Data['code'] = if ($parsed -and $parsed.error) { $parsed.error.code } else { '' }
  throw $err
}
function Forge-Get($path) { Read-Answer ($client.GetAsync($ForgeUrl + '/api/v1/vault-agent' + $path).Result) }
function Forge-Post($path, $body) {
  $content = New-Object System.Net.Http.StringContent(($body | ConvertTo-Json), [Text.Encoding]::UTF8, 'application/json')
  Read-Answer ($client.PostAsync($ForgeUrl + '/api/v1/vault-agent' + $path, $content).Result)
}
function Forge-Send($path, $file) {
  $stream = [System.IO.File]::Open($file, 'Open', 'Read', 'ReadWrite')
  try {
    $content = New-Object System.Net.Http.StreamContent($stream)
    $content.Headers.ContentType = New-Object System.Net.Http.Headers.MediaTypeHeaderValue('application/octet-stream')
    return Read-Answer ($client.PostAsync($ForgeUrl + '/api/v1/vault-agent' + $path, $content).Result)
  } finally { $stream.Dispose() }
}

function Stamp($info) { [string]$info.Length + '|' + [string]$info.LastWriteTimeUtc.Ticks }
function Rel-Of($full) { $full.Substring($Folder.Length).TrimStart('\').Replace('\', '/') }
function Full-Of($rel) { Join-Path $Folder ($rel.Replace('/', '\')) }
function Hash-Of($full) { (Get-FileHash -LiteralPath $full -Algorithm SHA256).Hash.ToLower() }
function Is-CadFile($info) { $Types -contains $info.Extension.TrimStart('.').ToLower() -and -not $info.Name.StartsWith('~') -and -not $info.Name.StartsWith('.') }

# One window at a time touches the folder and the saved state.
$mutex = New-Object System.Threading.Mutex($false, 'Local\ForgeVaultState')
function Load-State {
  $s = @{}
  if (Test-Path $StateFile) {
    try {
      $saved = Get-Content $StateFile -Raw | ConvertFrom-Json
      foreach ($p in $saved.PSObject.Properties) { $s[$p.Name] = @{ id = $p.Value.id; version = [int]$p.Value.version; sha = $p.Value.sha; stamp = $p.Value.stamp } }
    } catch { Say 'The saved state could not be read. Starting fresh.' }
  }
  return $s
}
function Save-State($s) { $s | ConvertTo-Json -Depth 3 -Compress | Set-Content -Path $StateFile -Encoding UTF8 }

# Writable only where this person may push, the file is being worked on, and nobody else
# has it locked. Everything else stays read-only, so SOLIDWORKS opens it read-only.
function Want-ReadOnly($r) { -not ($r.level -eq 'PUSH' -and $r.state -eq 'WIP' -and (-not $r.checkedOutBy -or $r.mine)) }
function Set-ReadOnly($full, $readOnly) {
  try { $i = Get-Item -LiteralPath $full; if ($i.IsReadOnly -ne [bool]$readOnly) { $i.IsReadOnly = [bool]$readOnly }; [ForgeShell]::Updated($full) } catch {}
}

# Fetches a vault version beside the file, then swaps it in. A file open in SOLIDWORKS
# cannot be swapped: close it first.
function Get-Latest($r) {
  $full = Full-Of $r.path
  New-Item -ItemType Directory -Force -Path (Split-Path $full -Parent) | Out-Null
  $temp = Join-Path (Split-Path $full -Parent) ('.forge-' + [guid]::NewGuid().ToString('N') + '.tmp')
  $response = $client.GetAsync($ForgeUrl + '/api/v1/vault-agent/files/' + $r.id + '/download', [System.Net.Http.HttpCompletionOption]::ResponseHeadersRead).Result
  if (-not $response.IsSuccessStatusCode) { Read-Answer $response | Out-Null }
  $out = [System.IO.File]::Create($temp)
  try { $response.Content.ReadAsStreamAsync().Result.CopyTo($out) } finally { $out.Dispose() }
  try {
    if (Test-Path -LiteralPath $full) { (Get-Item -LiteralPath $full).IsReadOnly = $false }
    Move-Item -LiteralPath $temp -Destination $full -Force
  } catch {
    Remove-Item -LiteralPath $temp -Force -ErrorAction SilentlyContinue
    throw (New-Object Exception ('It is open in another program (SOLIDWORKS?). Close it and pull again.'))
  }
  Set-ReadOnly $full (Want-ReadOnly $r)
  $info = Get-Item -LiteralPath $full
  return @{ id = $r.id; version = [int]$r.version; sha = $r.sha256; stamp = (Stamp $info) }
}

# ---------- What differs between this PC and Forge ----------
# Each row: Kind is one of
#   Vault-new    in Forge, not on this PC yet          (pull)
#   Behind       Forge has a newer version             (pull)
#   Conflict     Forge has a newer version AND you changed your copy (pull sets yours aside)
#   Changed      you changed it, from the latest version (push)
#   New          on this PC only                       (push)
function Get-Differences($scope) {
  $remote = (Forge-Get '/manifest').files
  $byKey = @{}
  foreach ($f in $remote) { $byKey[$f.path.ToLower()] = $f }
  $state = Load-State
  $locals = @{}
  if (Test-Path $Folder) {
    Get-ChildItem -LiteralPath $Folder -Recurse -File -Force -ErrorAction SilentlyContinue |
      Where-Object { (Is-CadFile $_) -and -not ($_.Attributes -band [IO.FileAttributes]::Hidden) } |
      ForEach-Object { $locals[(Rel-Of $_.FullName).ToLower()] = $_ }
  }
  $inScope = { param($key) -not $scope -or $key -eq $scope -or $key.StartsWith($scope + '/') }
  $rows = New-Object System.Collections.Generic.List[object]
  foreach ($key in (@($byKey.Keys) + @($locals.Keys) | Select-Object -Unique)) {
    if (-not (& $inScope $key)) { continue }
    $r = $byKey[$key]; $info = $locals[$key]; $st = $state[$key]
    $changed = $false
    if ($info) {
      if ($st -and $st.stamp -eq (Stamp $info)) { $changed = $false }
      else {
        $hash = Hash-Of $info.FullName
        $known = if ($st) { $st.sha } elseif ($r) { $r.sha256 } else { '' }
        $changed = $hash -ne $known
        if (-not $changed -and $r -and -not $st) { $state[$key] = @{ id = $r.id; version = [int]$r.version; sha = $hash; stamp = (Stamp $info) }; $st = $state[$key] }
      }
    }
    $kind = $null
    if ($r -and -not $info) { $kind = 'Vault-new' }
    elseif ($info -and -not $r) { $kind = 'New' }
    elseif ($r -and $info) {
      $base = if ($st) { [int]$st.version } else { 0 }
      $behind = $base -lt [int]$r.version -and $st.sha -ne $r.sha256
      if (-not $st -and $changed) { $behind = $true }
      if ($behind -and $changed) { $kind = 'Conflict' }
      elseif ($behind) { $kind = 'Behind' }
      elseif ($changed) { $kind = 'Changed' }
    }
    if ($kind) { $rows.Add([pscustomobject]@{ Key = $key; Rel = $(if ($r) { $r.path } else { Rel-Of $info.FullName }); Kind = $kind; Remote = $r; Info = $info; Base = $(if ($st) { [int]$st.version } else { $null }) }) }
  }
  Save-State $state
  return @{ rows = $rows; remote = $byKey; locals = $locals }
}

# ---------- Windows ----------
function New-Window($title, $width, $height) {
  $form = New-Object System.Windows.Forms.Form
  $form.Text = 'Forge Vault: ' + $title
  $form.Size = New-Object System.Drawing.Size($width, $height)
  $form.StartPosition = 'CenterScreen'
  $form.Font = New-Object System.Drawing.Font('Segoe UI', 9)
  $form.TopMost = $true
  try { $form.Icon = New-Object System.Drawing.Icon($IconFile) } catch {}
  return $form
}
function New-List($form, $top, $height) {
  $list = New-Object System.Windows.Forms.ListView
  $list.View = 'Details'; $list.CheckBoxes = $true; $list.FullRowSelect = $true
  $list.SetBounds(12, $top, $form.ClientSize.Width - 24, $height)
  $list.Anchor = 'Top, Left, Right, Bottom'
  [void]$list.Columns.Add('File', 330); [void]$list.Columns.Add('What', 200); [void]$list.Columns.Add('Vault', 190)
  $form.Controls.Add($list)
  return $list
}
function New-Button($form, $text, $x, $y, $w) {
  $b = New-Object System.Windows.Forms.Button
  $b.Text = $text; $b.SetBounds($x, $y, $w, 30); $b.Anchor = 'Bottom, Right'
  $form.Controls.Add($b)
  return $b
}
function Vault-Text($r) {
  if (-not $r) { return 'not in the vault yet' }
  $t = 'v' + $r.version + $(if ($r.revision) { ' rev ' + $r.revision } else { '' })
  if ($r.checkedOutBy) { $t += $(if ($r.mine) { ', locked by you' } else { ', locked by ' + $r.checkedOutBy }) }
  if ($r.state -ne 'WIP') { $t += ', ' + $r.state.ToLower() }
  return $t
}

function Show-Pull($scope) {
  $d = Get-Differences $scope
  $rows = @($d.rows | Where-Object { $_.Kind -in @('Vault-new', 'Behind', 'Conflict') })
  if ($rows.Count -eq 0) { Show 'Everything here is up to date with Forge.'; return }
  $form = New-Window 'Pull' 780 460
  $label = New-Object System.Windows.Forms.Label
  $label.SetBounds(12, 10, 740, 36)
  $label.Text = 'These files are newer in Forge, or not on this PC yet. Ticked files are pulled. A file marked Conflict has changes of yours too: pulling it sets your copy aside in ' + $SetAside + '.'
  $form.Controls.Add($label)
  $list = New-List $form 50 320
  foreach ($row in $rows) {
    $what = switch ($row.Kind) { 'Vault-new' { 'New from Forge' } 'Behind' { 'Newer in Forge (you have v' + $row.Base + ')' } 'Conflict' { 'Conflict: you changed it too' } }
    $item = New-Object System.Windows.Forms.ListViewItem($row.Rel)
    [void]$item.SubItems.Add($what); [void]$item.SubItems.Add((Vault-Text $row.Remote) + ', by ' + $row.Remote.lastChangedBy)
    $item.Checked = $row.Kind -ne 'Conflict'
    $item.Tag = $row
    if ($row.Kind -eq 'Conflict') { $item.ForeColor = [System.Drawing.Color]::DarkRed }
    [void]$list.Items.Add($item)
  }
  $ok = New-Button $form 'Pull' 560 385 100
  $cancel = New-Button $form 'Cancel' 668 385 84
  $cancel.DialogResult = 'Cancel'; $form.CancelButton = $cancel
  $ok.Add_Click({
    $ok.Enabled = $false
    $state = Load-State
    $done = 0; $failed = @()
    foreach ($item in $list.Items) {
      if (-not $item.Checked) { continue }
      $row = $item.Tag
      try {
        if ($row.Kind -eq 'Conflict') {
          New-Item -ItemType Directory -Force -Path $SetAside | Out-Null
          Copy-Item -LiteralPath $row.Info.FullName -Destination (Join-Path $SetAside ((Get-Date -Format 'yyyyMMdd-HHmmss') + ' ' + $row.Info.Name))
        }
        $state[$row.Key] = Get-Latest $row.Remote
        $item.SubItems[1].Text = 'Pulled v' + $row.Remote.version
        $done += 1
      } catch { $item.SubItems[1].Text = 'Not pulled: ' + $_.Exception.Message; $item.ForeColor = [System.Drawing.Color]::DarkRed; $failed += $row.Rel }
      [System.Windows.Forms.Application]::DoEvents()
    }
    Save-State $state
    Write-Status
    Say ('Pulled ' + $done + ' file(s)' + $(if ($failed) { ', ' + $failed.Count + ' not pulled' } else { '' }))
    $ok.Visible = $false; $cancel.Text = 'Close'
  })
  [void]$form.ShowDialog()
}

function Show-Push($scope) {
  $d = Get-Differences $scope
  $rows = @($d.rows | Where-Object { $_.Kind -in @('Changed', 'New', 'Conflict') })
  if ($rows.Count -eq 0) { Show 'Nothing to push: none of your files here differ from Forge.'; return }
  $form = New-Window 'Push' 780 560
  $label = New-Object System.Windows.Forms.Label
  $label.SetBounds(12, 10, 740, 20)
  $label.Text = 'Your changed and new files. Ticked files are sent to Forge as new versions.'
  $form.Controls.Add($label)
  $list = New-List $form 34 300
  foreach ($row in $rows) {
    $r = $row.Remote
    $why = $null
    if ($row.Kind -eq 'Conflict') { $why = 'Pull first: someone pushed v' + $r.version + ' after yours' }
    elseif ($r -and $r.level -ne 'PUSH') { $why = 'You may pull this, not push it' }
    elseif ($r -and $r.state -ne 'WIP') { $why = 'Released: a new revision is needed' }
    elseif ($r -and $r.checkedOutBy -and -not $r.mine) { $why = 'Locked by ' + $r.checkedOutBy }
    $what = if ($why) { $why } elseif ($row.Kind -eq 'New') { 'New file' } else { 'Changed from v' + $row.Base }
    $item = New-Object System.Windows.Forms.ListViewItem($row.Rel)
    [void]$item.SubItems.Add($what); [void]$item.SubItems.Add((Vault-Text $r))
    $item.Checked = -not $why
    $item.Tag = @{ row = $row; blocked = [bool]$why }
    if ($why) { $item.ForeColor = [System.Drawing.Color]::Gray }
    [void]$list.Items.Add($item)
  }
  $list.Add_ItemCheck({ param($s, $e) if ($list.Items[$e.Index].Tag.blocked) { $e.NewValue = 'Unchecked' } })
  $msgLabel = New-Object System.Windows.Forms.Label
  $msgLabel.Text = 'What changed (everyone sees this, like a commit message):'
  $msgLabel.SetBounds(12, 342, 740, 18); $msgLabel.Anchor = 'Bottom, Left'
  $form.Controls.Add($msgLabel)
  $message = New-Object System.Windows.Forms.TextBox
  $message.Multiline = $true; $message.SetBounds(12, 362, 740, 70); $message.Anchor = 'Bottom, Left, Right'
  $form.Controls.Add($message)
  $unlock = New-Object System.Windows.Forms.CheckBox
  $unlock.Text = 'Unlock files I had locked, after pushing'; $unlock.Checked = $true
  $unlock.SetBounds(12, 440, 400, 22); $unlock.Anchor = 'Bottom, Left'
  $form.Controls.Add($unlock)
  $ok = New-Button $form 'Push' 560 478 100
  $cancel = New-Button $form 'Cancel' 668 478 84
  $cancel.DialogResult = 'Cancel'; $form.CancelButton = $cancel
  $ok.Add_Click({
    if (-not $message.Text.Trim()) { Show 'Write what changed first.' 'Warning'; return }
    $ok.Enabled = $false
    try { $pushId = (Forge-Post '/pushes' @{ message = $message.Text.Trim() }).pushId }
    catch { Show ('Forge could not start the push: ' + $_.Exception.Message) 'Warning'; $ok.Enabled = $true; return }
    $state = Load-State
    $sent = 0
    foreach ($item in $list.Items) {
      if (-not $item.Checked) { continue }
      $row = $item.Tag.row
      $q = '/push?pushId=' + $pushId + '&path=' + [Uri]::EscapeDataString($row.Rel)
      if ($row.Remote) { $q += '&base=' + $row.Base }
      if ($unlock.Checked) { $q += '&unlock=true' }
      try {
        $a = Forge-Send $q $row.Info.FullName
        $info = Get-Item -LiteralPath $row.Info.FullName
        $state[$row.Key] = @{ id = $a.id; version = [int]$a.version; sha = $a.sha256; stamp = (Stamp $info) }
        $item.SubItems[1].Text = $(if ($a.status -eq 'UNCHANGED') { 'Same as Forge, nothing sent' } else { 'Pushed as v' + $a.version })
        $item.ForeColor = [System.Drawing.Color]::DarkGreen
        if ($unlock.Checked -and $row.Remote -and $row.Remote.mine) { Set-ReadOnly $row.Info.FullName $true }
        $sent += 1
      } catch {
        $item.SubItems[1].Text = 'Not pushed: ' + $_.Exception.Message
        $item.ForeColor = [System.Drawing.Color]::DarkRed
      }
      [System.Windows.Forms.Application]::DoEvents()
    }
    Save-State $state
    Write-Status
    Say ('Pushed ' + $sent + ' file(s): ' + $message.Text.Trim())
    $ok.Visible = $false; $cancel.Text = 'Close'
  })
  [void]$form.ShowDialog()
}

function Ask-Note($title, $prompt, $required) {
  $form = New-Window $title 460 230
  $label = New-Object System.Windows.Forms.Label
  $label.Text = $prompt; $label.SetBounds(12, 12, 420, 36)
  $box = New-Object System.Windows.Forms.TextBox
  $box.Multiline = $true; $box.SetBounds(12, 50, 420, 80)
  $ok = New-Object System.Windows.Forms.Button
  $ok.Text = $title; $ok.SetBounds(232, 142, 110, 30); $ok.DialogResult = 'OK'
  $cancel = New-Object System.Windows.Forms.Button
  $cancel.Text = 'Cancel'; $cancel.SetBounds(350, 142, 82, 30); $cancel.DialogResult = 'Cancel'
  $form.Controls.AddRange(@($label, $box, $ok, $cancel))
  $form.CancelButton = $cancel
  while ($true) {
    if ($form.ShowDialog() -ne 'OK') { return $null }
    if (-not $required -or $box.Text.Trim()) { return $box.Text.Trim() }
    Show 'Please write a note first.' 'Warning'
  }
}

# Badges for Explorer: one line per vault file on this PC.
function Write-Status {
  try {
    $remote = (Forge-Get '/manifest').files
    $lines = New-Object System.Collections.Generic.List[string]
    foreach ($r in $remote) {
      $full = Full-Of $r.path
      if (-not (Test-Path -LiteralPath $full)) { continue }
      $flag = if ($r.mine) { 'M' } elseif ($r.checkedOutBy) { 'L' } elseif ($r.state -eq 'RELEASED') { 'R' } elseif ($r.state -eq 'REVIEW') { 'V' } elseif ($r.state -eq 'OBSOLETE') { 'O' } else { 'W' }
      $lines.Add($full.ToLower() + [char]9 + $flag + [char]9 + $r.revision + [char]9 + $r.version + [char]9 + $r.checkedOutBy)
    }
    [IO.File]::WriteAllText($StatusFile, [string]::Join([Environment]::NewLine, $lines), (New-Object Text.UTF8Encoding($false)))
    [ForgeShell]::Everything()
  } catch { Say ('Could not refresh badges: ' + $_.Exception.Message) }
}

# ---------- A right-click action ----------
if ($Action) {
  if (-not $mutex.WaitOne(60000)) { Show 'Forge Vault is busy in another window. Try again in a moment.' 'Warning'; exit }
  try {
    $full = (Resolve-Path -LiteralPath $Target).Path.TrimEnd('\')
    $inside = $full.ToLower() -eq $Folder.ToLower() -or $full.ToLower().StartsWith($Folder.ToLower() + '\')
    if (-not $inside) { Show 'This is not in the Forge Vault folder.' 'Warning'; exit }
    $scope = if ($full.ToLower() -eq $Folder.ToLower()) { '' } else { (Rel-Of $full).ToLower() }
    switch ($Action) {
      'pullall' { Show-Pull $scope }
      'pushall' { Show-Push $scope }
      'push'    { Show-Push $scope }
      'pull' {
        $d = Get-Differences $scope
        $row = $d.rows | Select-Object -First 1
        if (-not $row -or $row.Kind -eq 'Changed' -or $row.Kind -eq 'New') { if (-not $row) { Show 'This file is already the latest version.' } else { Show 'You changed this file and Forge has nothing newer. Push it to send your change.' }; break }
        if ($row.Kind -eq 'Conflict' -and -not (Ask-Yes ('Forge has a newer version (v' + $row.Remote.version + ' by ' + $row.Remote.lastChangedBy + '), and you changed your copy too.' + [Environment]::NewLine + 'Pull it? Your copy is set aside in ' + $SetAside + '.'))) { break }
        if ($row.Kind -eq 'Conflict') { New-Item -ItemType Directory -Force -Path $SetAside | Out-Null; Copy-Item -LiteralPath $full -Destination (Join-Path $SetAside ((Get-Date -Format 'yyyyMMdd-HHmmss') + ' ' + (Split-Path $full -Leaf))) }
        $state = Load-State
        $state[$row.Key] = Get-Latest $row.Remote
        Save-State $state
        Show ((Split-Path $full -Leaf) + ' is now version ' + $row.Remote.version + '.')
      }
      'open' {
        $s = Forge-Get ('/status?path=' + [Uri]::EscapeDataString((Rel-Of $full)))
        Start-Process ($ForgeUrl + '/vault/' + $s.id)
      }
      default {
        $rel = Rel-Of $full
        $s = $null
        try { $s = Forge-Get ('/status?path=' + [Uri]::EscapeDataString($rel)) } catch { if ($_.Exception.Data['status'] -ne 404) { throw } }
        if (-not $s) { Show 'This file is not in the vault yet. Push it first.'; break }
        $what = @{
          lock    = @('', '', $false, 'lock', 'is locked to you. You can change it now; push when done.');
          unlock  = @('', '', $false, 'unlock', 'is unlocked.');
          submit  = @('Send for review', 'Note for the reviewer (optional)', $false, 'submit', 'is sent for review.');
          release = @('Approve and release', 'Release note (optional). The file gets its next revision letter and becomes read-only.', $false, 'release', 'is released as revision {rev}.');
          reject  = @('Send back', 'What needs changing?', $true, 'reject', 'is sent back to be worked on.');
          newrev  = @('Start new revision', 'Reason, such as the change note number (optional)', $false, 'new-revision', 'can be changed again. Lock it to change it.')
        }[$Action]
        if (-not $what) { break }
        $note = ''
        if ($what[0]) { $note = Ask-Note $what[0] $what[1] $what[2]; if ($null -eq $note) { break } }
        if ($Action -eq 'lock') {
          $state = Load-State
          $st = $state[$rel.ToLower()]
          if ((-not $st -or [int]$st.version -lt [int]$s.version) -and (Hash-Of $full) -ne $s.sha256) {
            Show ('Forge has a newer version (v' + $s.version + ' by ' + $s.lastChangedBy + '). Pull it first, then lock.') 'Warning'; break
          }
        }
        if ($Action -eq 'unlock' -and $s.mine) {
          $state = Load-State
          $st = $state[$rel.ToLower()]
          if ($st -and $st.stamp -ne (Stamp (Get-Item -LiteralPath $full)) -and (Hash-Of $full) -ne $st.sha) {
            if (-not (Ask-Yes 'You changed this file and have not pushed. Unlock anyway? Your changes stay on this PC, but someone else may push first.')) { break }
          }
        }
        $r = Forge-Post ('/files/' + $s.id + '/' + $what[3]) @{ note = $note }
        $after = [pscustomobject]@{ level = $s.level; state = $r.state; checkedOutBy = $r.checkedOutBy; mine = ($Action -eq 'lock') }
        Set-ReadOnly $full (Want-ReadOnly $after)
        Show ((Split-Path $full -Leaf) + ' ' + $what[4].Replace('{rev}', [string]$r.revision))
      }
    }
    Write-Status
  } catch {
    Say ('Action ' + $Action + ' on ' + $Target + ' failed: ' + $_.Exception.Message)
    Show ('Forge could not do that.' + [Environment]::NewLine + [Environment]::NewLine + $_.Exception.Message) 'Warning'
  } finally { $mutex.ReleaseMutex() }
  exit
}

# ---------- The tray icon: tells, never copies ----------
$single = New-Object System.Threading.Mutex($false, 'Local\ForgeVaultTray')
if (-not $single.WaitOne(0)) { exit }
$icon = New-Object System.Windows.Forms.NotifyIcon
try { $icon.Icon = New-Object System.Drawing.Icon($IconFile) } catch { $icon.Icon = [System.Drawing.SystemIcons]::Application }
$icon.Text = 'Forge Vault'
$icon.Visible = $true
$run = { param($a) Start-Process powershell.exe -WindowStyle Hidden -ArgumentList ('-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $Self + '" -Action ' + $a + ' -Target "' + $Folder + '"') }
$menu = New-Object System.Windows.Forms.ContextMenuStrip
$menu.Items.Add('Pull...', $null, { & $run 'pullall' }) | Out-Null
$menu.Items.Add('Push...', $null, { & $run 'pushall' }) | Out-Null
$menu.Items.Add('-') | Out-Null
$menu.Items.Add('Open the Forge Vault folder', $null, { Start-Process explorer.exe ('"' + $Folder + '"') }) | Out-Null
$menu.Items.Add('Open Forge', $null, { Start-Process ($ForgeUrl + '/vault') }) | Out-Null
$menu.Items.Add('My vault tasks', $null, { Start-Process ($ForgeUrl + '/vault?tab=tasks') }) | Out-Null
$menu.Items.Add('Files set aside', $null, { New-Item -ItemType Directory -Force -Path $SetAside | Out-Null; Start-Process explorer.exe ('"' + $SetAside + '"') }) | Out-Null
$menu.Items.Add('Show the log', $null, { Start-Process notepad.exe ('"' + $LogFile + '"') }) | Out-Null
$menu.Items.Add('-') | Out-Null
$script:quit = $false
$menu.Items.Add('Quit until next sign-in', $null, { $script:quit = $true }) | Out-Null
$icon.ContextMenuStrip = $menu
$icon.add_DoubleClick({ Start-Process explorer.exe ('"' + $Folder + '"') })

$lastNewer = -1
while (-not $script:quit) {
  # Only looks: counts what could be pulled and pushed. Moving files is always your choice.
  if ($mutex.WaitOne(1000)) {
    try {
      $d = Get-Differences ''
      $toPull = @($d.rows | Where-Object { $_.Kind -in @('Vault-new', 'Behind', 'Conflict') }).Count
      $toPush = @($d.rows | Where-Object { $_.Kind -in @('Changed', 'New') }).Count
      $text = 'Forge Vault: ' + $toPull + ' to pull, ' + $toPush + ' to push'
      $icon.Text = $text.Substring(0, [Math]::Min(63, $text.Length))
      if ($toPull -gt 0 -and $toPull -ne $lastNewer) {
        $icon.BalloonTipTitle = 'Forge Vault'
        $icon.BalloonTipText = [string]$toPull + ' file(s) are newer in Forge. Right-click the icon > Pull to get them.'
        $icon.ShowBalloonTip(6000)
      }
      $lastNewer = $toPull
      Write-Status
    } catch { $icon.Text = 'Forge Vault: cannot reach Forge' }
    finally { $mutex.ReleaseMutex() }
  }
  for ($i = 0; $i -lt 1200 -and -not $script:quit; $i++) { [System.Windows.Forms.Application]::DoEvents(); Start-Sleep -Milliseconds 100 }
}
$icon.Visible = $false
$icon.Dispose()
