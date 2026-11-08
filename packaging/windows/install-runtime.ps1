# Fetches what Forge needs to run, checks each download against the checksum its maker
# publishes, and keeps only the files it uses. The setup program runs this, not a person.
param(
  [Parameter(Mandatory = $true)][string]$InstallDir
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

$work = Join-Path $env:TEMP 'forge-setup'
New-Item -ItemType Directory -Force -Path $work | Out-Null
$runtime = Join-Path $InstallDir 'runtime'
New-Item -ItemType Directory -Force -Path $runtime | Out-Null

$downloads = @(
  @{
    Name = 'Node.js 22.23.4'; Size = '36 MB'
    Url = 'https://nodejs.org/dist/v22.23.4/node-v22.23.4-win-x64.zip'
    Sha256 = 'cbc74b5e0982c9dbb41525fd8fb5dcd32fbee237863f7829072f4639a1ce5f20'
    File = 'node-v22.23.4-win-x64.zip'
    Extract = @(@{ Member = 'node-v22.23.4-win-x64/node.exe'; Target = 'runtime\node\node.exe' })
  },
  @{
    Name = 'MongoDB 7.0.14'; Size = '620 MB'
    Url = 'https://fastdl.mongodb.org/windows/mongodb-windows-x86_64-7.0.14.zip'
    Sha256 = '59aa714af531e2b68ce01fa1be9999435fb9bc2b2002439f3271470113bdf7fe'
    File = 'mongodb-windows-x86_64-7.0.14.zip'
    Extract = @(
      @{ Member = 'mongodb-win32-x86_64-windows-7.0.14/bin/mongod.exe'; Target = 'runtime\mongodb\mongod.exe' },
      @{ Member = 'mongodb-win32-x86_64-windows-7.0.14/bin/vc_redist.x64.exe'; Target = 'runtime\mongodb\vc_redist.x64.exe' }
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
  return ((Get-FileHash -Algorithm SHA256 -Path $path).Hash.ToLower() -eq $want)
}

function Get-Download($item) {
  $path = Join-Path $work $item.File
  if ((Test-Path $path) -and (Test-Hash $path $item.Sha256)) { return $path }
  if (Test-Path $path) { Remove-Item $path -Force }
  Write-Output "Downloading $($item.Name), $($item.Size). This can take several minutes."
  $curl = Join-Path $env:SystemRoot 'System32\curl.exe'
  if (Test-Path $curl) {
    & $curl --location --fail --silent --show-error --retry 3 --output $path $item.Url
    if ($LASTEXITCODE -ne 0) { throw "The download of $($item.Name) failed (curl $LASTEXITCODE)." }
  } else {
    Invoke-WebRequest -Uri $item.Url -OutFile $path -UseBasicParsing
  }
  if (-not (Test-Hash $path $item.Sha256)) {
    Remove-Item $path -Force
    throw "$($item.Name) did not match its published checksum, so it was not used."
  }
  Write-Output "$($item.Name) matches its published checksum."
  return $path
}

try {
  foreach ($item in $downloads) {
    if (Test-Done $item) {
      Write-Output "$($item.Name) is already in place."
      continue
    }
    $zip = Get-Download $item
    $out = Join-Path $work ([IO.Path]::GetFileNameWithoutExtension($item.File))
    if (Test-Path $out) { Remove-Item $out -Recurse -Force }
    New-Item -ItemType Directory -Force -Path $out | Out-Null
    foreach ($entry in $item.Extract) {
      & tar.exe -xf $zip -C $out $entry.Member
      if ($LASTEXITCODE -ne 0) { throw "Could not unpack $($entry.Member)." }
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
  Write-Output 'Installing the Microsoft Visual C++ runtime that MongoDB needs.'
  $redist = Join-Path $InstallDir 'runtime\mongodb\vc_redist.x64.exe'
  $process = Start-Process -FilePath $redist -ArgumentList '/install', '/quiet', '/norestart' -Wait -PassThru
  if (@(0, 1638, 3010) -notcontains $process.ExitCode) {
    throw "The Visual C++ runtime did not install (code $($process.ExitCode))."
  }
  Write-Output 'Everything Forge needs is in place.'
  exit 0
} catch {
  Write-Output "ERROR: $($_.Exception.Message)"
  exit 1
}
