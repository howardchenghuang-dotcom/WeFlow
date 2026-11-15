# Local WeFlow AI desktop launcher. Stable port 18108 is never modified.
$ErrorActionPreference = 'Stop'

function Test-LocalPort([int]$Port) {
  $socket = New-Object System.Net.Sockets.TcpClient
  try {
    $socket.Connect('127.0.0.1', $Port)
    return $true
  }
  catch { return $false }
  finally { $socket.Dispose() }
}

function Get-LauncherToken {
  # The token is encrypted with the current Windows user's DPAPI key.
  $directory = Join-Path $env:LOCALAPPDATA 'WeFlow\AI-Launcher'
  $file = Join-Path $directory 'api-token.dpapi'
  if (Test-Path -LiteralPath $file) {
    $encrypted = (Get-Content -LiteralPath $file -Raw).Trim()
    $secure = ConvertTo-SecureString -String $encrypted
    $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
    try { return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer) }
    finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer) }
  }

  $bytes = New-Object byte[] 32
  $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
  try { $rng.GetBytes($bytes) }
  finally { $rng.Dispose() }
  $secret = -join ($bytes | ForEach-Object { $_.ToString('x2') })
  New-Item -ItemType Directory -Path $directory -Force | Out-Null
  $encoded = ConvertTo-SecureString -String $secret -AsPlainText -Force | ConvertFrom-SecureString
  Set-Content -LiteralPath $file -Value $encoded -Encoding ASCII
  return $secret
}

try {
  $root = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\..')).Path
  $backend = Join-Path $root 'preview-bin\weflow.exe'
  $ui = Join-Path $root 'web\dist'
  $bridge = Join-Path $PSScriptRoot 'node_modules\electron\dist\electron.exe'

  if (-not (Test-Path -LiteralPath $backend -PathType Leaf)) {
    throw 'WeFlow AI backend is missing. Expected preview-bin\weflow.exe.'
  }
  if (-not (Test-Path -LiteralPath (Join-Path $ui 'index.html') -PathType Leaf)) {
    throw 'WeFlow AI WebUI is missing. Build it with bun run check inside the web folder.'
  }

  $token = Get-LauncherToken
  $alreadyRunning = Test-LocalPort 18110
  if (-not $alreadyRunning) {
    $previous = [Environment]::GetEnvironmentVariable('WEFLOW_HTTP_TOKEN', 'Process')
    try {
      # Passing the token through an environment variable avoids exposing it in the process command line.
      $env:WEFLOW_HTTP_TOKEN = $token
      $backendArgs = 'serve --host 127.0.0.1 --port 18110 --ui-dir "' + $ui + '" --no-browser'
      Start-Process -FilePath $backend -ArgumentList $backendArgs -WorkingDirectory $root -WindowStyle Hidden | Out-Null
    }
    finally {
      if ($null -eq $previous) { Remove-Item Env:\WEFLOW_HTTP_TOKEN -ErrorAction SilentlyContinue }
      else { $env:WEFLOW_HTTP_TOKEN = $previous }
    }
    for ($n = 0; $n -lt 60 -and -not (Test-LocalPort 18110); $n++) {
      Start-Sleep -Milliseconds 250
    }
    if (-not (Test-LocalPort 18110)) { throw 'WeFlow AI did not start on port 18110.' }
  }

  if (-not (Test-LocalPort 18109)) {
    if (-not (Test-Path -LiteralPath $bridge -PathType Leaf)) {
      throw 'ChatGPT local bridge is missing. Run npm install in tools\ai-bridge.'
    }
    Start-Process -FilePath $bridge -ArgumentList ('"' + $PSScriptRoot + '"') -WorkingDirectory $PSScriptRoot -WindowStyle Hidden | Out-Null
    for ($n = 0; $n -lt 40 -and -not (Test-LocalPort 18109); $n++) {
      Start-Sleep -Milliseconds 250
    }
    if (-not (Test-LocalPort 18109)) { throw 'ChatGPT local bridge did not start on port 18109.' }
  }

  # A previously started manual backend may use a different access token.
  # Never pretend this launcher's new token controls a different live process.
  if ($alreadyRunning) {
    Start-Process 'http://127.0.0.1:18110/ui/' | Out-Null
  }
  else {
    $url = 'http://127.0.0.1:18110/ui/?token=' + [Uri]::EscapeDataString($token)
    Start-Process $url | Out-Null
  }
}
catch {
  Add-Type -AssemblyName System.Windows.Forms
  [System.Windows.Forms.MessageBox]::Show(
    $_.Exception.Message,
    'WeFlow AI',
    [System.Windows.Forms.MessageBoxButtons]::OK,
    [System.Windows.Forms.MessageBoxIcon]::Error
  ) | Out-Null
  exit 1
}
