# Starts Forge ERP from this folder on Windows. The first run downloads Node.js and MongoDB into
# runtime\, checked against the checksums their makers publish. Close this window to stop Forge.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

$Root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$App = Join-Path $Root 'app'
$Runtime = Join-Path $Root 'runtime'
$Data = Join-Path $Root 'data'
$Url = 'http://localhost:4100/'
New-Item -ItemType Directory -Force -Path $Runtime, $Data | Out-Null

function Get-Runtime($Name, $File, $Sha, $Address, $Members) {
  $done = Join-Path $Runtime ".$File.sha256"
  if ((Test-Path $done) -and ((Get-Content $done -Raw).Trim() -eq $Sha)) { return }
  Write-Host "Downloading $Name. This happens once, and can take several minutes."
  $zip = Join-Path $Runtime $File
  & (Join-Path $env:SystemRoot 'System32\curl.exe') --location --fail --progress-bar --retry 3 --output $zip $Address
  if ($LASTEXITCODE -ne 0) { throw "The download of $Name failed." }
  if ((Get-FileHash -Algorithm SHA256 $zip).Hash.ToLower() -ne $Sha) {
    Remove-Item $zip -Force
    throw "$Name did not match its published checksum, so it was not used."
  }
  foreach ($member in $Members.Keys) {
    & tar.exe -xf $zip -C $Runtime $member
    if ($LASTEXITCODE -ne 0) { throw "Could not unpack $member." }
    Move-Item -Force (Join-Path $Runtime ($member -replace '/', '\')) (Join-Path $Runtime $Members[$member])
  }
  Remove-Item $zip -Force
  Remove-Item -Recurse -Force (Join-Path $Runtime (($Members.Keys | Select-Object -First 1).Split('/')[0]))
  Set-Content -Path $done -Value $Sha -Encoding Ascii
}

try {
  Get-Runtime 'Node.js (36 MB)' 'node-v22.23.4-win-x64.zip' 'cbc74b5e0982c9dbb41525fd8fb5dcd32fbee237863f7829072f4639a1ce5f20' `
    'https://nodejs.org/dist/v22.23.4/node-v22.23.4-win-x64.zip' @{ 'node-v22.23.4-win-x64/node.exe' = 'node.exe' }
  Get-Runtime 'MongoDB (620 MB)' 'mongodb-windows-x86_64-7.0.14.zip' '59aa714af531e2b68ce01fa1be9999435fb9bc2b2002439f3271470113bdf7fe' `
    'https://fastdl.mongodb.org/windows/mongodb-windows-x86_64-7.0.14.zip' @{
      'mongodb-win32-x86_64-windows-7.0.14/bin/mongod.exe' = 'mongod.exe'
      'mongodb-win32-x86_64-windows-7.0.14/bin/vc_redist.x64.exe' = 'vc_redist.x64.exe'
    }

  # MongoDB needs Microsoft's Visual C++ runtime. Windows asks for permission once to add it.
  $redistDone = Join-Path $Runtime '.vc_redist.done'
  if (-not (Test-Path $redistDone)) {
    Write-Host 'Adding the Microsoft Visual C++ runtime that MongoDB needs. Windows will ask for permission.'
    $p = Start-Process -FilePath (Join-Path $Runtime 'vc_redist.x64.exe') -ArgumentList '/install', '/quiet', '/norestart' -Verb RunAs -Wait -PassThru
    if (@(0, 1638, 3010) -notcontains $p.ExitCode) { throw "The Visual C++ runtime did not install (code $($p.ExitCode))." }
    Set-Content -Path $redistDone -Value 'ok'
  }

  $node = Join-Path $Runtime 'node.exe'
  $setup = Join-Path $App 'server\scripts\windowsSetup.js'
  & $node $setup prepare --data $Data --host keep | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'Could not write the settings.' }

  $mongo = Start-Process -FilePath (Join-Path $Runtime 'mongod.exe') -ArgumentList '--config', "`"$(Join-Path $Data 'mongod.cfg')`"" -WindowStyle Hidden -PassThru
  & $node $setup replset --data $Data | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'The database did not start. Its log is in the data\logs folder.' }

  $signIn = Join-Path $Data 'sign-in.txt'
  if (-not (Test-Path $signIn)) {
    $bytes = New-Object byte[] 24
    [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
    $password = (([Convert]::ToBase64String($bytes)) -replace '[^A-Za-z0-9]', '').Substring(0, 16)
    $env:ADMIN_EMAIL = 'admin@forge.local'; $env:ADMIN_NAME = 'Administrator'; $env:ADMIN_PASSWORD = $password; $env:ADMIN_IF_NONE = '1'
    $output = & $node "--env-file=$(Join-Path $Data 'forge.env')" (Join-Path $App 'server\scripts\createAdmin.js') 2>&1 | Out-String
    Remove-Item Env:ADMIN_PASSWORD
    if ($output -match 'created') { Set-Content -Path $signIn -Value "Forge ERP`r`nOpen: $Url`r`nEmail: admin@forge.local`r`nPassword: $password" }
  }
  if (Test-Path $signIn) { Write-Host ''; Get-Content $signIn | Write-Host; Write-Host '' }

  $server = Start-Process -FilePath $node -ArgumentList "--env-file=`"$(Join-Path $Data 'forge.env')`"", 'server.js' -WorkingDirectory (Join-Path $App 'server') -NoNewWindow -PassThru
  & $node $setup wait-ready --data $Data | Out-Null
  if ($LASTEXITCODE -eq 0) { Start-Process $Url }
  Write-Host "Forge is running at $Url. Keep this window open. Close it to stop Forge."
  Wait-Process -Id $server.Id
} catch {
  Write-Host ''
  Write-Host "Forge could not start: $($_.Exception.Message)" -ForegroundColor Red
  Read-Host 'Press Enter to close'
} finally {
  if ($mongo -and -not $mongo.HasExited) { Stop-Process -Id $mongo.Id -Force }
}
