# Sets WeFlow AI up on this computer in one go, and can be run again after `git pull` to bring it up to date:
#   1. the bridge's dependencies (Electron), from package-lock.json
#   2. OpenAI's Sign in with ChatGPT DevKit, at the commit this bridge was written against, built locally
#   3. the WebUI (web\dist), built with bun
#   4. the backend (preview-bin\weflow.exe): the build GitHub Actions made of this branch, or a local cargo build
#   5. the desktop shortcut (and, with -Startup, the sign-in shortcut)
# Nothing is installed outside this checkout except those shortcuts. Quit WeFlow AI first (tray icon > Quit).
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1
#
# -UpdateBackend fetches the backend again even when one is there; -NoShortcut leaves the desktop alone.
param([switch]$UpdateBackend, [switch]$NoShortcut, [switch]$Startup)
$ErrorActionPreference = 'Stop'

$DevKitRepository = 'https://github.com/openai/sign-in-with-chatgpt-devkit.git'
# Pinned: a newer DevKit is taken on purpose, by changing this line and testing, not by whoever installs next.
$DevKitCommit = '0a36fefeb913055c8c7a1a29b63d82b96b2e841a'
$Workflow = 'personal-ai.yml'
$BackendArtifact = 'personal-weflow-api-v3-windows-x64'

$bridge = $PSScriptRoot
$root = (Resolve-Path -LiteralPath (Join-Path $bridge '..\..')).Path
$web = Join-Path $root 'web'
$previewBin = Join-Path $root 'preview-bin'
$backend = Join-Path $previewBin 'weflow.exe'
$devkit = Join-Path $bridge 'siwc-devkit'

function Step([string]$Text) { Write-Host ''; Write-Host "== $Text" -ForegroundColor Cyan }
function Has([string]$Command) { return [bool](Get-Command $Command -ErrorAction SilentlyContinue) }

# Runs a program and stops the installer when it fails: PowerShell itself goes on after a failed program.
function Run([string]$Directory, [string]$Program, [string[]]$Arguments) {
  Push-Location -LiteralPath $Directory
  try {
    & $Program @Arguments
    if ($LASTEXITCODE -ne 0) { throw "$Program $($Arguments -join ' ') failed with exit code $LASTEXITCODE (in $Directory)." }
  }
  finally { Pop-Location }
}

function Test-Listening([int]$Port) {
  $socket = New-Object System.Net.Sockets.TcpClient
  try { $socket.Connect('127.0.0.1', $Port); return $true }
  catch { return $false }
  finally { $socket.Dispose() }
}

Step 'Checking what is needed'
foreach ($tool in 'node', 'npm', 'git') {
  if (-not (Has $tool)) { throw "$tool is not installed or not on PATH. Install Node.js 22.12 or later (it brings npm) and Git, then run this again." }
}
$nodeVersion = [version]((& node --version).TrimStart('v'))
if ($nodeVersion -lt [version]'22.12.0') { throw "Node.js $nodeVersion is too old; 22.12 or later is needed." }
if ((Test-Listening 18109) -or (Test-Listening 18110)) {
  throw 'WeFlow AI is running (port 18109 or 18110 is in use). Quit it first: right-click the green WeFlow AI icon near the clock and choose Quit. Then run this again.'
}
Write-Host "node $nodeVersion, npm and git found."

Step 'Bridge dependencies (Electron)'
Run $bridge 'npm' @('ci')
# Electron's package no longer downloads its program on install, only the first time it is used through npm.
# The launcher starts that program directly, so it is fetched here.
$electron = Join-Path $bridge 'node_modules\electron\dist\electron.exe'
if (-not (Test-Path -LiteralPath $electron -PathType Leaf)) {
  Run $bridge 'node' @('node_modules\electron\install.js')
}
if (-not (Test-Path -LiteralPath $electron -PathType Leaf)) {
  throw 'Electron was installed but its program (node_modules\electron\dist\electron.exe) is missing. Check the network and run this again.'
}

Step 'Sign in with ChatGPT DevKit'
if (-not (Test-Path -LiteralPath (Join-Path $devkit '.git'))) {
  Run $bridge 'git' @('clone', '--quiet', $DevKitRepository, 'siwc-devkit')
}
$have = (& git -C $devkit rev-parse HEAD).Trim()
$built = Test-Path -LiteralPath (Join-Path $devkit 'packages\local\dist\index.js') -PathType Leaf
if ($have -ne $DevKitCommit -or -not $built) {
  if ($have -ne $DevKitCommit) {
    Run $devkit 'git' @('fetch', '--quiet', 'origin')
    Run $devkit 'git' @('checkout', '--quiet', '--detach', $DevKitCommit)
  }
  Run $devkit 'npm' @('ci')
  Run $devkit 'npm' @('run', 'build', '-w', '@siwc/local')
}
else { Write-Host "Already built at $($DevKitCommit.Substring(0, 7))." }

Step 'WebUI'
if (-not (Has 'bun')) {
  throw 'bun is not installed or not on PATH; it builds the WebUI. Install it from https://bun.sh (one command), open a new PowerShell and run this again.'
}
Run $web 'bun' @('install', '--frozen-lockfile')
Run $web 'bun' @('run', 'build')

Step 'Backend (preview-bin\weflow.exe)'
if ($UpdateBackend -or -not (Test-Path -LiteralPath $backend -PathType Leaf)) {
  New-Item -ItemType Directory -Path $previewBin -Force | Out-Null
  $fetched = $false
  if (Has 'gh') {
    # The repository is named: inside a fork, gh would otherwise look at the repository it was forked from.
    $origin = (& git -C $root remote get-url origin).Trim()
    $branch = (& git -C $root branch --show-current).Trim()
    if ($origin -match 'github\.com[:/]([^/]+)/([^/]+?)(\.git)?$' -and $branch) {
      $repository = $Matches[1] + '/' + $Matches[2]
      $run = (& gh run list --repo $repository --workflow $Workflow --branch $branch --status success --limit 1 --json databaseId --jq '.[0].databaseId')
      if ($LASTEXITCODE -eq 0 -and "$run" -match '^\d+$') {
        $download = Join-Path $previewBin '.download'
        if (Test-Path -LiteralPath $download) { Remove-Item -LiteralPath $download -Recurse -Force }
        & gh run download $run --repo $repository --name $BackendArtifact --dir $download
        if ($LASTEXITCODE -eq 0 -and (Test-Path -LiteralPath (Join-Path $download 'weflow.exe'))) {
          Move-Item -LiteralPath (Join-Path $download 'weflow.exe') -Destination $backend -Force
          Remove-Item -LiteralPath $download -Recurse -Force
          Write-Host "Downloaded the build of run $run ($repository, branch $branch)."
          $fetched = $true
        }
      }
      if (-not $fetched) {
        Write-Host "No downloadable build of branch $branch was found on GitHub (builds are kept 90 days)." -ForegroundColor Yellow
        Write-Host "To make one: gh workflow run $Workflow --repo $repository --ref $branch   (then run this again in about 10 minutes)" -ForegroundColor Yellow
      }
    }
  }
  if (-not $fetched -and (Has 'cargo')) {
    Write-Host 'Building the backend here with cargo (several minutes the first time)...'
    Run $root 'cargo' @('build', '--release', '-p', 'weflow-cli')
    Copy-Item -LiteralPath (Join-Path $root 'target\release\weflow.exe') -Destination $backend -Force
    $fetched = $true
  }
  if (-not $fetched) {
    throw 'The backend could not be fetched or built. Install the GitHub CLI (gh) and sign in with "gh auth login", or install Rust (rustup), then run this again.'
  }
}
else { Write-Host 'Already there. Run with -UpdateBackend to fetch it again.' }
& $backend --version
if ($LASTEXITCODE -ne 0) { throw 'preview-bin\weflow.exe does not run.' }

if (-not $NoShortcut) {
  Step 'Shortcuts'
  & (Join-Path $bridge 'install-desktop.ps1')
  if ($Startup) { & (Join-Path $bridge 'install-startup.ps1') }
}

Write-Host ''
Write-Host 'WeFlow AI is ready. Double-click "WeFlow AI" on the desktop.' -ForegroundColor Green
