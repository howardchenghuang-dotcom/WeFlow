# Creates a double-clickable WeFlow AI shortcut on this Windows user's desktop.
$ErrorActionPreference = 'Stop'
$launcher = Join-Path $PSScriptRoot 'launch-weflow-ai.ps1'
if (-not (Test-Path -LiteralPath $launcher -PathType Leaf)) {
  throw "The launcher file does not exist: $launcher"
}
$desktop = [Environment]::GetFolderPath('Desktop')
if (-not (Test-Path -LiteralPath $desktop -PathType Container)) {
  throw 'Windows desktop folder cannot be found.'
}
$shortcutPath = Join-Path $desktop 'WeFlow AI.lnk'
$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($shortcutPath)
$shortcut.TargetPath = Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe'
$shortcut.Arguments = '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $launcher + '"'
$shortcut.WorkingDirectory = $PSScriptRoot
$shortcut.WindowStyle = 7
$shortcut.IconLocation = (Join-Path $env:WINDIR 'System32\SHELL32.dll') + ',14'
$shortcut.Description = 'Launch WeFlow AI backend, ChatGPT bridge and web browser'
$shortcut.Save()
Write-Host "WeFlow AI desktop shortcut created: $shortcutPath"
Write-Host 'On the first run, stop your old manually started 18110 backend before double-clicking.'
