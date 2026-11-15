# Enables automatic starting of the local AI bridge when this Windows user signs in.
# This creates only a current-user Startup shortcut; no administrator permissions.
# Run once from tools/ai-bridge: powershell -ExecutionPolicy Bypass -File .\install-startup.ps1
$ErrorActionPreference = 'Stop'
$electron = Join-Path $PSScriptRoot 'node_modules\electron\dist\electron.exe'
if (-not (Test-Path -LiteralPath $electron)) {
  throw 'Electron is not installed. Run npm install in tools/ai-bridge first.'
}
$startup = [Environment]::GetFolderPath('Startup')
$shortcutPath = Join-Path $startup 'WeFlow Personal AI Bridge.lnk'
$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($shortcutPath)
$shortcut.TargetPath = $electron
$shortcut.Arguments = ('"' + $PSScriptRoot + '"')
$shortcut.WorkingDirectory = $PSScriptRoot
$shortcut.WindowStyle = 7
$shortcut.Description = 'WeFlow personal local AI bridge; serves 127.0.0.1:18109'
$shortcut.Save()
Write-Host 'Automatic login startup shortcut created.'
Write-Host 'Startup shortcut:' $shortcutPath
Write-Host 'This affects only your Windows account. To undo, delete this shortcut.'
