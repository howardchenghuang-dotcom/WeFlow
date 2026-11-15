import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { stopBackend } from '../backend.mjs';

const windows = process.platform === 'win32';

/** Another node process listening on a free port, standing in for the backend. */
async function listener() {
  const child = spawn(process.execPath, ['-e',
    "const s=require('node:http').createServer().listen(0,'127.0.0.1',()=>console.log(s.address().port))"]);
  const [line] = await once(child.stdout, 'data');
  return { child, port: Number(String(line).trim()) };
}

describe('quitting from the tray', () => {
  it('reports what PowerShell answered, and a failure as one', async () => {
    const answers = { ok: 'stopped\r\n', noise: 'WARNING: x\r\nforeign\r\n', odd: 'something else' };
    const run = text => (_file, _args, _options, done) => done(null, text);
    assert.equal(await stopBackend({ exePath: 'C:\\x\\weflow.exe', platform: 'win32', run: run(answers.ok) }), 'stopped');
    assert.equal(await stopBackend({ exePath: 'C:\\x\\weflow.exe', platform: 'win32', run: run(answers.noise) }), 'foreign');
    assert.equal(await stopBackend({ exePath: 'C:\\x\\weflow.exe', platform: 'win32', run: run(answers.odd) }), 'failed');
    const broken = (_file, _args, _options, done) => done(new Error('no powershell'), '');
    assert.equal(await stopBackend({ exePath: 'C:\\x\\weflow.exe', platform: 'win32', run: broken }), 'failed');
    assert.equal(await stopBackend({ exePath: '/x/weflow', platform: 'linux' }), 'failed');
  });

  it('passes the path through the environment, never the command line', async () => {
    let seen;
    const run = (file, args, options, done) => { seen = { file, args, options }; done(null, 'absent'); };
    await stopBackend({ exePath: 'C:\\a b\\"; Remove-Item x; "\\weflow.exe', port: 4242, platform: 'win32', run });
    assert.equal(seen.args.join(' ').includes('Remove-Item'), false);
    assert.equal(seen.options.env.WEFLOW_STOP_EXE, 'C:\\a b\\"; Remove-Item x; "\\weflow.exe');
    assert.equal(seen.options.env.WEFLOW_STOP_PORT, '4242');
  });

  it('ends the program on the port only when it is the expected one', { skip: !windows }, async () => {
    const { child, port } = await listener();
    try {
      assert.equal(await stopBackend({ exePath: 'C:\\somewhere\\else\\weflow.exe', port }), 'foreign');
      assert.equal(child.exitCode, null);
      const exited = once(child, 'exit');
      assert.equal(await stopBackend({ exePath: process.execPath, port }), 'stopped');
      await exited;
      assert.equal(await stopBackend({ exePath: process.execPath, port }), 'absent');
    } finally {
      child.kill();
    }
  });
});
