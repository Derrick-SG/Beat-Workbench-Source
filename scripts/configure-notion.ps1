$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$OutputEncoding = [Console]::OutputEncoding
$nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
$bundledNode = Join-Path $env:USERPROFILE '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe'
if ($nodeCommand) { $nodePath = $nodeCommand.Source } elseif (Test-Path -LiteralPath $bundledNode) { $nodePath = $bundledNode } else { Write-Host 'Node.js 22+ is required. Ask PM to configure the runtime.'; exit 1 }
$nodeVersion = & $nodePath --version
if ($LASTEXITCODE -ne 0 -or [int](([string]$nodeVersion).Trim().TrimStart('v').Split('.')[0]) -lt 22) { Write-Host 'Node.js 22+ is required.'; exit 1 }
$exitCode = 1
do {
  $secret = $null
  $secretPointer = [IntPtr]::Zero
  $tokenText = $null
  try {
    $inputMethod = (Read-Host '令牌输入方式：复制令牌后输入 C 从本机剪贴板读取；输入 M 使用隐藏手动输入（默认 M）').Trim().ToUpperInvariant()
    if ($inputMethod -eq 'C') {
      $tokenText = [string](Get-Clipboard -Raw)
    } else {
      $secret = Read-Host 'Notion内部连接令牌（隐藏输入，不发送到聊天）' -AsSecureString
      $secretPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secret)
      $tokenText = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($secretPointer)
    }
    $env:BW_NOTION_PARENT = Read-Host '已授权空白父页ID（32位或标准带横线UUID，不是完整链接）'
    $env:BW_NOTION_TOKEN = $tokenText
    & $nodePath (Join-Path $PSScriptRoot 'notion/configure.mjs')
    $exitCode = $LASTEXITCODE
  } catch {
    Write-Host '本机配置流程未完成。请核对当前用户控制台与Node.js运行环境；不要发送令牌或原始错误。'
    $exitCode = 1
  } finally {
    Remove-Item Env:BW_NOTION_TOKEN -ErrorAction SilentlyContinue
    Remove-Item Env:BW_NOTION_PARENT -ErrorAction SilentlyContinue
    if ($secretPointer -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($secretPointer) }
    if ($secret -is [Security.SecureString]) { $secret.Dispose() }
    $tokenText = $null
  }
  if ($exitCode -eq 0) { break }
  if ($exitCode -notin @(2, 3)) { break }
  $again = Read-Host '输入未保存。重新隐藏输入两项？输入Y重试，其他键结束'
} while ($again -eq 'Y')
exit $exitCode
