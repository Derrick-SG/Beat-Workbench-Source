param([switch]$Disable)
$ErrorActionPreference='Stop'
$startup= [Environment]::GetFolderPath('Startup')
if(!$startup){throw 'Current user Startup folder unavailable.'}
$linkPath=Join-Path $startup 'Beat-Workbench.lnk'
$target=Join-Path $env:SystemRoot 'System32/WindowsPowerShell/v1.0/powershell.exe'
$launch=Join-Path $PSScriptRoot 'start-workbench.ps1'
$arguments='-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "'+$launch+'" -ServiceOnly'
$shell=New-Object -ComObject WScript.Shell
if(Test-Path -LiteralPath $linkPath){
  $existing=$shell.CreateShortcut($linkPath)
  if($existing.TargetPath -ne $target -or $existing.Arguments -ne $arguments){throw 'A different Beat-Workbench startup shortcut exists; no changes made.'}
  if($Disable){Remove-Item -LiteralPath $linkPath;Write-Host 'Login startup disabled. Running service is unchanged.';exit 0}
  Write-Host 'Login startup already enabled for this project.';exit 0
}
if($Disable){Write-Host 'Login startup is already disabled.';exit 0}
$link=$shell.CreateShortcut($linkPath)
$link.TargetPath=$target;$link.Arguments=$arguments;$link.WorkingDirectory=Split-Path -Parent $PSScriptRoot;$link.Description='Beat-Workbench loopback service (current user login)';$link.WindowStyle=7;$link.Save()
Write-Host ('Login startup enabled: '+$linkPath)
Write-Host 'No browser opens automatically. Use http://127.0.0.1:4173/#work-entry after login.'
