# Native diagnostics only; never enumerates credential environment variables.
$ErrorActionPreference = 'Stop'
$body = @'
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$fixture = Join-Path ([IO.Path]::GetTempPath()) ('relay-verification-acl-' + [Guid]::NewGuid())
$result = @{ version = $PSVersionTable.PSVersion.ToString(); edition = $PSVersionTable.PSEdition; modulePath = $env:PSModulePath }
try {
  $result.modules = @(Get-Module -ListAvailable Microsoft.PowerShell.Security | Select-Object Name, Version, Path)
  Import-Module Microsoft.PowerShell.Security -Force -ErrorAction Stop
  New-Item -ItemType Directory -Path $fixture | Out-Null
  $acl = Get-Acl -LiteralPath $fixture
  Set-Acl -LiteralPath $fixture -AclObject $acl
  $result.aclRoundtrip = 'passed'
} catch { $result.aclRoundtrip = 'failed'; $result.error = $_.Exception.Message }
finally { if (Test-Path -LiteralPath $fixture) { Remove-Item -LiteralPath $fixture -Recurse -Force } }
$result | ConvertTo-Json -Depth 6 -Compress
'@
$encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($body))
$results = @()
foreach ($shellName in @('powershell.exe', 'pwsh.exe')) {
  $executable = (Get-Command $shellName -ErrorAction SilentlyContinue).Source
  if (-not $executable) { continue }
  foreach ($cleanModulePath in @($false, $true)) {
    $info = [Diagnostics.ProcessStartInfo]::new()
    $info.FileName = $executable
    $info.UseShellExecute = $false
    $info.RedirectStandardOutput = $true
    $info.RedirectStandardError = $true
    foreach ($argument in @('-NoProfile', '-NonInteractive', '-EncodedCommand', $encoded)) { $info.ArgumentList.Add($argument) }
    if ($cleanModulePath) { [void]$info.Environment.Remove('PSModulePath') }
    $process = [Diagnostics.Process]::new(); $process.StartInfo = $info
    [void]$process.Start()
    $stdout = $process.StandardOutput.ReadToEndAsync(); $stderr = $process.StandardError.ReadToEndAsync()
    if (-not $process.WaitForExit(45000)) { $process.Kill($true); throw 'Native shell probe timed out' }
    $results += @{ executable = $executable; cleanModulePath = $cleanModulePath; exit = $process.ExitCode; stdout = $stdout.GetAwaiter().GetResult(); stderr = $stderr.GetAwaiter().GetResult() }
  }
}
$destination = Join-Path $PWD '.release-tmp/agent-cli-platforms/windows-shell/diagnostics.json'
New-Item -ItemType Directory -Path (Split-Path $destination) -Force | Out-Null
$results | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $destination
Write-Output "Native shell diagnostics saved to $destination"
