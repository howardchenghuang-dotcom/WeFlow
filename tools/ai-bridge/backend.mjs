// Stopping the WeFlow backend when the person quits from the tray. The launcher starts it hidden, so without
// this the only way to stop it is Task Manager. Free of Electron, so `node --test` runs it.
import { execFile } from 'node:child_process';

export const BACKEND_PORT = 18110;

// The path and the port come in through the environment, not the command line: nothing to quote, nothing to inject.
const SCRIPT = [
  '$ErrorActionPreference = "Stop"',
  '$listener = Get-NetTCPConnection -LocalPort ([int]$env:WEFLOW_STOP_PORT) -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1',
  'if (-not $listener) { "absent"; exit 0 }',
  '$process = Get-Process -Id $listener.OwningProcess',
  'if (-not $process.Path -or -not $process.Path.Equals($env:WEFLOW_STOP_EXE, [StringComparison]::OrdinalIgnoreCase)) { "foreign"; exit 0 }',
  'Stop-Process -Id $process.Id -Force',
  '"stopped"',
].join('; ');

/**
 * Ends the program listening on `port` when, and only when, it is `exePath`: the backend the launcher started.
 * Anything else on that port is left alone.
 * @returns {Promise<'stopped' | 'absent' | 'foreign' | 'failed'>}
 */
export function stopBackend({ exePath, port = BACKEND_PORT, platform = process.platform, run = execFile }) {
  if (platform !== 'win32') return Promise.resolve('failed');
  return new Promise(resolve => {
    run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', SCRIPT], {
      env: { ...process.env, WEFLOW_STOP_EXE: exePath, WEFLOW_STOP_PORT: String(port) },
      windowsHide: true,
      timeout: 15_000,
    }, (error, stdout) => {
      const answer = String(stdout ?? '').trim().split(/\s+/).pop();
      resolve(!error && ['stopped', 'absent', 'foreign'].includes(answer) ? answer : 'failed');
    });
  });
}
