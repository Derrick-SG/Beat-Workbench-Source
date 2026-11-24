param([switch]$ServiceOnly,[switch]$Stop)
$ErrorActionPreference='Stop'
$projectRoot=Split-Path -Parent $PSScriptRoot
$runtimeDir=Join-Path $projectRoot '.local'
New-Item -ItemType Directory -Path $runtimeDir -Force | Out-Null
$logPath=Join-Path $runtimeDir 'startup.log'
$recordPath=Join-Path $runtimeDir 'server.json'
try {
  $nodeCommand=Get-Command node.exe -ErrorAction SilentlyContinue
  $bundledNode=Join-Path $env:USERPROFILE '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe'
  if($nodeCommand){$nodePath=$nodeCommand.Source}elseif(Test-Path -LiteralPath $bundledNode){$nodePath=$bundledNode}else{throw 'Node.js not found. Install Node.js 22+ or ask PM to configure the existing runtime.'}
  $version=& $nodePath --version
  if($LASTEXITCODE -ne 0){throw 'Unable to run Node.js.'}
  $version=([string]$version).Trim().TrimStart('v').Split('.')[0]
  if([int]$version -lt 22){throw 'Node.js 22+ is required.'}
  if($Stop){
    if(!(Test-Path -LiteralPath $recordPath)){throw 'No service owned by this launcher. No process was stopped.'}
    $record=Get-Content -LiteralPath $recordPath -Raw | ConvertFrom-Json
    $probe=& $nodePath (Join-Path $PSScriptRoot 'launch.mjs') --probe | ConvertFrom-Json
    $process=Get-Process -Id $record.pid -ErrorAction Stop
    if($probe.status -ne 'ready' -or $probe.pid -ne $record.pid -or $probe.project -ne $record.project -or $process.ProcessName -ne 'node' -or $process.StartTime.ToUniversalTime().Ticks.ToString() -ne $record.startTicks -or $process.Path -ne $record.nodePath){throw 'Service ownership could not be confirmed. No process was stopped.'}
    Stop-Process -Id $process.Id -ErrorAction Stop
    Remove-Item -LiteralPath $recordPath
    Write-Host 'Beat-Workbench service stopped. Browser data remains unchanged.'
    exit 0
  }
  $output=& $nodePath (Join-Path $PSScriptRoot 'launch.mjs') 2>&1
  if($LASTEXITCODE -ne 0){throw ($output -join "`n")}
  $result=($output -join "`n") | ConvertFrom-Json
  if($result.status -eq 'started'){
    $process=Get-Process -Id $result.pid
    @{pid=$result.pid;project=$result.project;startTicks=$process.StartTime.ToUniversalTime().Ticks.ToString();nodePath=$process.Path} | ConvertTo-Json | Set-Content -LiteralPath $recordPath -Encoding UTF8
  }
  Add-Content -LiteralPath $logPath -Value ((Get-Date -Format 'yyyy-MM-dd HH:mm:ss')+' '+$result.status+' '+$result.url) -Encoding UTF8
  if(!$ServiceOnly){Start-Process $result.url}
}catch{
  Add-Content -LiteralPath $logPath -Value ((Get-Date -Format 'yyyy-MM-dd HH:mm:ss')+' ERROR '+$_.Exception.Message) -Encoding UTF8
  if(!$ServiceOnly){Write-Host $_.Exception.Message;Write-Host ('Log: '+$logPath)}
  exit 1
}
