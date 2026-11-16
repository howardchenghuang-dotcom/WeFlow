# Local WeFlow AI desktop launcher. Stable port 18108 is never modified.
# -NoBrowser starts the backend and the bridge without opening the page: what the sign-in shortcut of
# install-startup.ps1 runs, so that the page is ready whenever it is opened later.
param([switch]$NoBrowser)
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

# Full path of the program listening on a local port, or $null when it cannot be told.
function Get-PortOwnerPath([int]$Port) {
  try {
    $listener = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction Stop | Select-Object -First 1
    return (Get-Process -Id $listener.OwningProcess -ErrorAction Stop).Path
  }
  catch { return $null }
}

# Whether the server on 18110 takes this token: 'ok', 'unauthorized', or 'offline' (no answer yet).
function Test-BackendToken([string]$Token) {
  try {
    $request = [System.Net.WebRequest]::Create('http://127.0.0.1:18110/jobs')
    $request.Timeout = 3000
    $request.Proxy = $null
    $request.Headers.Add('Authorization', 'Bearer ' + $Token)
    $response = $request.GetResponse()
    $response.Close()
    return 'ok'
  }
  catch [System.Net.WebException] {
    $answer = $_.Exception.Response
    if ($null -ne $answer -and [int]$answer.StatusCode -eq 401) { return 'unauthorized' }
    if ($null -ne $answer) { return 'ok' }
    return 'offline'
  }
}

function Get-LauncherToken {
  # The token is encrypted with the current Windows user's DPAPI key.
  $directory = Join-Path $env:LOCALAPPDATA 'WeFlow\AI-Launcher'
  $file = Join-Path $directory 'api-token.dpapi'
  if (Test-Path -LiteralPath $file) {
    try {
      $encrypted = ([string](Get-Content -LiteralPath $file -Raw)).Trim()
      $secure = ConvertTo-SecureString -String $encrypted
      $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
      try { return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer) }
      finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer) }
    }
    catch {
      # An empty or damaged file, or one written under another Windows account: make a new token below
      # rather than fail on every double-click. A server still running with the old one is reported later.
    }
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
  if ($alreadyRunning) {
    # The token is a secret: it is only shown to the server this launcher starts, never to whatever else
    # happens to listen on the port.
    $owner = Get-PortOwnerPath 18110
    if ($null -eq $owner -or -not $owner.Equals($backend, [StringComparison]::OrdinalIgnoreCase)) {
      $name = $owner
      if ($null -eq $owner) { $name = 'an unknown program' }
      throw "Port 18110 is in use by $name, not by the WeFlow AI backend ($backend). Stop that program, then double-click WeFlow AI again."
    }
    if ((Test-BackendToken $token) -eq 'unauthorized') {
      throw 'The WeFlow AI backend on port 18110 was started by hand with another access token. Stop it (close its PowerShell window, or end weflow.exe in Task Manager), then double-click WeFlow AI again.'
    }
  }
  else {
    $previous = [Environment]::GetEnvironmentVariable('WEFLOW_HTTP_TOKEN', 'Process')
    try {
      # The backend takes the token from its environment, so it is not in that process's command line.
      # (It is in the address the browser is started with below: the WebUI needs it once per tab.)
      $env:WEFLOW_HTTP_TOKEN = $token
      $backendArgs = 'serve --host 127.0.0.1 --port 18110 --ui-dir "' + $ui + '" --no-browser'
      Start-Process -FilePath $backend -ArgumentList $backendArgs -WorkingDirectory $root -WindowStyle Hidden | Out-Null
    }
    finally {
      if ($null -eq $previous) { Remove-Item Env:\WEFLOW_HTTP_TOKEN -ErrorAction SilentlyContinue }
      else { $env:WEFLOW_HTTP_TOKEN = $previous }
    }
    # Ready means that it answers with this token, not only that the port is open.
    for ($n = 0; $n -lt 120 -and (Test-BackendToken $token) -ne 'ok'; $n++) {
      Start-Sleep -Milliseconds 250
    }
    if ((Test-BackendToken $token) -ne 'ok') { throw 'WeFlow AI did not start on port 18110.' }
  }

  if (Test-LocalPort 18109) {
    $owner = Get-PortOwnerPath 18109
    if ($null -ne $owner -and -not $owner.Equals($bridge, [StringComparison]::OrdinalIgnoreCase)) {
      throw "Port 18109 is in use by $owner, not by the WeFlow AI bridge. Stop that program, then double-click WeFlow AI again."
    }
  }
  else {
    if (-not (Test-Path -LiteralPath $bridge -PathType Leaf)) {
      throw 'ChatGPT local bridge is missing. Run npm install in tools\ai-bridge.'
    }
    Start-Process -FilePath $bridge -ArgumentList ('"' + $PSScriptRoot + '"') -WorkingDirectory $PSScriptRoot -WindowStyle Hidden | Out-Null
    for ($n = 0; $n -lt 40 -and -not (Test-LocalPort 18109); $n++) {
      Start-Sleep -Milliseconds 250
    }
    if (-not (Test-LocalPort 18109)) { throw 'ChatGPT local bridge did not start on port 18109.' }
  }

  # Always supply the launcher's persistent, locally encrypted token.
  # The WebUI strips it from the address bar once consumed. Opening /ui/ alone
  # loses authentication in a fresh browser tab even when this launcher owns the service.
  # By now the server on 18110 is known to be this launcher's backend and to take this token.
  $url = 'http://127.0.0.1:18110/ui/?token=' + [Uri]::EscapeDataString($token)
  if (-not $NoBrowser) { Start-Process $url | Out-Null }
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
