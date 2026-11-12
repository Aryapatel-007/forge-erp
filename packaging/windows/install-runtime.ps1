# Fetches what Forge needs to run, checks each download against the checksum its maker
# publishes, and keeps only the files it uses. The setup program runs this, not a person.
#
# Downloads are tried three ways, because offices differ: Windows' own background transfer
# (BITS, which follows the PC's proxy settings and survives a dropped connection), then
# curl, then a plain .NET download through the PC's proxy. Whatever fails is written to
# %TEMP%\forge-setup\setup.log, so the reason is never lost.
param(
  [Parameter(Mandatory = $true)][string]$InstallDir
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

$work = Join-Path $env:TEMP 'forge-setup'
New-Item -ItemType Directory -Force -Path $work | Out-Null
$log = Join-Path $work 'setup.log'
$runtime = Join-Path $InstallDir 'runtime'
New-Item -ItemType Directory -Force -Path $runtime | Out-Null

# Straight to the setup window's list, not to the pipeline: in PowerShell, anything a
# function writes to the pipeline becomes part of what it returns.
function Say($text) {
  [Console]::Out.WriteLine($text)
  try { Add-Content -Path $log -Value ((Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + '  ' + $text) } catch {}
}

$downloads = @(
  @{
    Name = 'Node.js 26.13.1'; Size = '39 MB'
    Url = 'https://nodejs.org/dist/v26.13.1/node-v26.13.1-win-x64.zip'
    Sha256 = 'e2edda75bfb089654705cf65a13b58933bfd5f57148e8ebda916f58a2474f1f7'
    File = 'node-v26.13.1-win-x64.zip'
    Extract = @(@{ Member = 'node-v26.13.1-win-x64/node.exe'; Target = 'runtime\node\node.exe' })
  },
  @{
    Name = 'MongoDB 9.0.8'; Size = '946 MB'
    Url = 'https://fastdl.mongodb.org/windows/mongodb-windows-x86_64-9.0.8.zip'
    Sha256 = 'ee18c81847efebd869564e8ec42ca37b0cac7fe353c321969c5db16c3b7e4e8e'
    File = 'mongodb-windows-x86_64-9.0.8.zip'
    Extract = @(
      @{ Member = 'mongodb-win32-x86_64-windows-9.0.8/bin/mongod.exe'; Target = 'runtime\mongodb\mongod.exe' },
      @{ Member = 'mongodb-win32-x86_64-windows-9.0.8/bin/vc_redist.x64.exe'; Target = 'runtime\mongodb\vc_redist.x64.exe' }
    )
  }
)

function Get-Marker($item) { Join-Path $runtime ".$($item.File).sha256" }

# Already in place from an earlier install, and from the same checked download.
function Test-Done($item) {
  $marker = Get-Marker $item
  if (-not (Test-Path $marker)) { return $false }
  if ((Get-Content $marker -Raw).Trim() -ne $item.Sha256) { return $false }
  foreach ($entry in $item.Extract) {
    if (-not (Test-Path (Join-Path $InstallDir $entry.Target))) { return $false }
  }
  return $true
}

function Test-Hash($path, $want) {
  if (-not (Test-Path $path)) { return $false }
  return ((Get-FileHash -Algorithm SHA256 -Path $path).Hash.ToLower() -eq $want)
}

# The proxy this PC uses for an address, as set in Windows, or nothing for a direct line.
function Get-ProxyFor($url) {
  try {
    $target = New-Object Uri $url
    $via = [System.Net.WebRequest]::GetSystemWebProxy().GetProxy($target)
    if ($via -and $via.AbsoluteUri -ne $target.AbsoluteUri) { return $via.AbsoluteUri }
  } catch {}
  return $null
}

# 1. Windows' background transfer. Follows the PC's proxy, resumes after a drop.
function Try-Bits($item, $path) {
  try {
    Import-Module BitsTransfer -ErrorAction Stop
    $job = Start-BitsTransfer -Source $item.Url -Destination $path -Asynchronous -Priority Foreground -DisplayName "Forge ERP setup: $($item.Name)" -ErrorAction Stop
    $lastReport = Get-Date
    $lastBytes = -1
    $stalledSince = Get-Date
    while ($true) {
      Start-Sleep -Seconds 2
      $state = "$($job.JobState)"
      if ($state -eq 'Transferred') { Complete-BitsTransfer -BitsJob $job; return $true }
      if ($state -eq 'Error' -or $state -eq 'Cancelled') { break }
      if ($job.BytesTransferred -ne $lastBytes) { $lastBytes = $job.BytesTransferred; $stalledSince = Get-Date }
      # Nothing moved for five minutes: give the next way a chance.
      if (((Get-Date) - $stalledSince).TotalMinutes -ge 5) { $state = 'stalled'; break }
      if (((Get-Date) - $lastReport).TotalSeconds -ge 15 -and $job.BytesTotal -gt 0 -and $job.BytesTotal -lt [UInt64]::MaxValue) {
        $lastReport = Get-Date
        Say ('  {0} MB of {1} MB' -f [math]::Floor($job.BytesTransferred / 1MB), [math]::Floor($job.BytesTotal / 1MB))
      }
    }
    Say "  Windows background download stopped: $state $($job.ErrorDescription)"
    Remove-BitsTransfer -BitsJob $job -ErrorAction SilentlyContinue
  } catch {
    Say "  Windows background download is not available here: $($_.Exception.Message)"
  }
  return $false
}

# 2. curl, which comes with Windows 10 and 11.
function Try-Curl($item, $path) {
  # Windows PowerShell 5 turns a native program's error text into a crash when errors stop
  # the script, so this step reads curl's errors as plain text instead.
  $ErrorActionPreference = 'Continue'
  $curl = Join-Path $env:SystemRoot 'System32\curl.exe'
  if (-not (Test-Path $curl)) { Say '  curl is not on this PC.'; return $false }
  $version = (& $curl --version 2>$null | Select-Object -First 1) -replace '^curl (\d+)\.(\d+).*$', '$1.$2'
  $flags = @('--location', '--fail', '--silent', '--show-error', '--connect-timeout', '30', '--retry', '5', '--retry-delay', '5', '--continue-at', '-', '--output', $path)
  # Many office networks block the certificate revocation check, which stops curl on Windows.
  $flags += '--ssl-no-revoke'
  try { if ([version]$version -ge [version]'7.71') { $flags += '--retry-all-errors' } } catch {}
  $proxy = Get-ProxyFor $item.Url
  if ($proxy) { $flags += @('--proxy', $proxy, '--proxy-anyauth', '--proxy-user', ':'); Say "  Using this PC's proxy, $proxy" }
  $out = (& $curl @flags $item.Url 2>&1 | ForEach-Object { "$_" }) -join ' '
  if ($LASTEXITCODE -eq 0) { return $true }
  Say "  curl could not download it (code $LASTEXITCODE): $out"
  return $false
}

# 3. A plain download through the PC's proxy, signed in as this Windows user.
function Try-DotNet($item, $path) {
  try {
    $client = New-Object System.Net.WebClient
    $client.Proxy = [System.Net.WebRequest]::GetSystemWebProxy()
    $client.Proxy.Credentials = [System.Net.CredentialCache]::DefaultNetworkCredentials
    $client.DownloadFile($item.Url, $path)
    return $true
  } catch {
    Say "  The plain download failed too: $($_.Exception.Message)"
    return $false
  }
}

function Get-Download($item) {
  $path = Join-Path $work $item.File
  if (Test-Hash $path $item.Sha256) { Say "$($item.Name) was downloaded before and is intact."; return $path }
  Say "Downloading $($item.Name), $($item.Size). This can take several minutes."
  foreach ($way in @('Try-Bits', 'Try-Curl', 'Try-DotNet')) {
    if (& $way $item $path) {
      if (Test-Hash $path $item.Sha256) {
        Say "$($item.Name) matches its published checksum."
        return $path
      }
      Say "  The file that arrived does not match the published checksum, so it was not used."
      Remove-Item $path -Force -ErrorAction SilentlyContinue
    }
  }
  throw "$($item.Name) could not be downloaded from $($item.Url). Check that this PC can open that address in a browser. If the office uses a proxy or firewall, it must allow nodejs.org and fastdl.mongodb.org."
}

try {
  Say "Forge ERP setup, Windows $([Environment]::OSVersion.Version), 64-bit process: $([Environment]::Is64BitProcess)"
  foreach ($item in $downloads) {
    if (Test-Done $item) {
      Say "$($item.Name) is already in place."
      continue
    }
    $zip = Get-Download $item
    $out = Join-Path $work ([IO.Path]::GetFileNameWithoutExtension($item.File))
    if (Test-Path $out) { Remove-Item $out -Recurse -Force }
    New-Item -ItemType Directory -Force -Path $out | Out-Null
    foreach ($entry in $item.Extract) {
      & tar.exe -xf $zip -C $out $entry.Member
      if ($LASTEXITCODE -ne 0) { throw "Could not unpack $($entry.Member) from $zip." }
      $target = Join-Path $InstallDir $entry.Target
      New-Item -ItemType Directory -Force -Path (Split-Path $target) | Out-Null
      Move-Item -Force -Path (Join-Path $out ($entry.Member -replace '/', '\')) -Destination $target
    }
    Set-Content -Path (Get-Marker $item) -Value $item.Sha256 -Encoding Ascii
    Remove-Item $zip -Force
    Remove-Item $out -Recurse -Force
  }

  # MongoDB needs Microsoft's Visual C++ runtime. 1638 means a newer one is already
  # installed, and 3010 that it is installed and takes full effect after a restart.
  Say 'Installing the Microsoft Visual C++ runtime that MongoDB needs.'
  $redist = Join-Path $InstallDir 'runtime\mongodb\vc_redist.x64.exe'
  $process = Start-Process -FilePath $redist -ArgumentList '/install', '/quiet', '/norestart' -Wait -PassThru
  if (@(0, 1638, 3010) -notcontains $process.ExitCode) {
    throw "The Visual C++ runtime did not install (code $($process.ExitCode))."
  }
  Say 'Everything Forge needs is in place.'
  exit 0
} catch {
  Say "ERROR: $($_.Exception.Message)"
  exit 1
}
