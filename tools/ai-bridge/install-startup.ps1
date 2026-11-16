# Starts WeFlow AI (backend on 18110 and AI bridge on 18109) when this Windows user signs in, without opening
# the browser. It creates only a shortcut in the current user's Startup folder; no administrator permissions.
# Run once from tools/ai-bridge: powershell -ExecutionPolicy Bypass -File .\install-startup.ps1
# To undo, delete "WeFlow AI (background).lnk" from the Startup folder (shell:startup).
$ErrorActionPreference = 'Stop'
$launcher = Join-Path $PSScriptRoot 'launch-weflow-ai.ps1'
if (-not (Test-Path -LiteralPath $launcher -PathType Leaf)) {
  throw "The launcher file does not exist: $launcher"
}
$startup = [Environment]::GetFolderPath('Startup')
# the shortcut of earlier versions started the bridge alone, which left the page without its backend
$old = Join-Path $startup 'WeFlow Personal AI Bridge.lnk'
if (Test-Path -LiteralPath $old) { Remove-Item -LiteralPath $old -Force }
$shortcutPath = Join-Path $startup 'WeFlow AI (background).lnk'
$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($shortcutPath)
$shortcut.TargetPath = Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe'
$shortcut.Arguments = '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $launcher + '" -NoBrowser'
$shortcut.WorkingDirectory = $PSScriptRoot
$shortcut.WindowStyle = 7
$shortcut.IconLocation = (Join-Path $env:WINDIR 'System32\SHELL32.dll') + ',14'
$shortcut.Description = 'Start the WeFlow AI backend and ChatGPT bridge in the background'
$shortcut.Save()
Write-Host 'WeFlow AI will start in the background when you sign in to Windows.'
Write-Host 'Startup shortcut:' $shortcutPath
Write-Host 'This affects only your Windows account. To undo, delete this shortcut.'
