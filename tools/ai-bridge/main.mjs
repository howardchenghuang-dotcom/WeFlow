import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, safeStorage, shell, Tray } from 'electron';
import { stopBackend } from './backend.mjs';
import { AI_PORT } from './guard.mjs';
import { createBridge } from './server.mjs';
import { encryptedSessionStore } from './session.mjs';

const HERE = import.meta.dirname;
const LAUNCHER = join(HERE, 'launch-weflow-ai.ps1');
// The backend the launcher starts, two folders up; the tray's Quit ends that program and no other.
const BACKEND = resolve(HERE, '..', '..', 'preview-bin', 'weflow.exe');

let client;
let mainWindow;
let server;
let tray;
let quitting = false;

function credentialEncryption() {
  const available = () => safeStorage.isEncryptionAvailable();
  const requireAvailable = () => {
    if (!available()) throw new Error('Windows OS credential encryption is unavailable.');
  };
  return {
    id: 'electron-safe-storage-v1',
    isAvailable: available,
    encrypt(value) { requireAvailable(); return safeStorage.encryptString(value); },
    decrypt(value) { requireAvailable(); return safeStorage.decryptString(Buffer.from(value)); },
  };
}

/**
 * Asked in a window of this process, which no web page and no forged request can answer. Without it any
 * program on this computer (or another Windows account) could pair itself and spend the ChatGPT plan.
 */
async function confirmPairing({ replacing }) {
  // The bridge has no window of its own; an always-on-top owner keeps the prompt above the browser.
  const owner = new BrowserWindow({ show: false, alwaysOnTop: true, skipTaskbar: true });
  try {
    const { response } = await dialog.showMessageBox(owner, {
      type: 'question',
      title: 'WeFlow AI',
      message: '允许这个浏览器使用本机的 ChatGPT 订阅吗？',
      detail: '浏览器里的 WeFlow 页面（http://127.0.0.1:18110）请求与本机 AI 桥接配对，有效期 90 天。\n\n'
        + '只有在你刚刚点击了「启用本机 AI 登录」时才选择允许。'
        + (replacing ? '\n\n注意：允许后，之前配对的浏览器将失效。' : ''),
      buttons: ['允许', '拒绝'],
      defaultId: 1,
      cancelId: 1,
      noLink: true,
    });
    return response === 0;
  } finally {
    owner.destroy();
  }
}

function createPanel() {
  if (mainWindow) { mainWindow.show(); mainWindow.focus(); return; }
  mainWindow = new BrowserWindow({
    width: 560, height: 400, title: 'WeFlow AI · ChatGPT',
    webPreferences: {
      contextIsolation: true, nodeIntegration: false, sandbox: true,
      preload: join(HERE, 'preload.cjs'),
    },
  });
  mainWindow.setMenuBarVisibility(false);
  mainWindow.loadFile(join(HERE, 'panel.html'));
  mainWindow.on('closed', () => { mainWindow = null; });
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
}

/** The launcher knows the token and starts what is not running; the tray only asks it to open the page. */
function openWebUi() {
  spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', LAUNCHER], {
    cwd: HERE, detached: true, stdio: 'ignore', windowsHide: true,
  }).unref();
}

async function quit() {
  if (quitting) return;
  quitting = true;
  // 'foreign' and 'absent' are fine: a backend started by hand, or none, is not this program's to end.
  const stopped = await stopBackend({ exePath: BACKEND });
  if (stopped === 'failed') console.error('The WeFlow backend on port 18110 could not be stopped.');
  app.quit();
}

/** The only visible part of the bridge: without it there is no way to see that it runs, or to stop it. */
function createTray() {
  tray = new Tray(nativeImage.createFromPath(join(HERE, 'tray.png')));
  tray.setToolTip('WeFlow AI');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '打开 WeFlow AI', click: openWebUi },
    { label: 'ChatGPT 连接状态…', click: createPanel },
    { label: '查看订阅用量', click: () => { void shell.openExternal('https://chatgpt.com/settings/usage'); } },
    { type: 'separator' },
    { label: '退出 WeFlow AI（同时停止本机后端）', click: () => { void quit(); } },
  ]));
  tray.on('double-click', openWebUi);
}

function installIpc() {
  const verify = (event) => {
    if (!mainWindow || event.sender !== mainWindow.webContents || event.senderFrame !== mainWindow.webContents.mainFrame) {
      throw new Error('Untrusted window');
    }
  };
  ipcMain.handle('bridge-status', async event => {
    verify(event);
    const session = await client.getSession();
    return { session, port: AI_PORT, ready: Boolean(server?.listening) };
  });
  ipcMain.handle('bridge-sign-in', async event => { verify(event); return client.signIn(); });
  ipcMain.handle('bridge-disconnect', async event => { verify(event); return client.disconnect(); });
  ipcMain.handle('bridge-open-usage', async event => {
    verify(event);
    await shell.openExternal('https://chatgpt.com/settings/usage');
  });
}

async function boot() {
  if (!safeStorage.isEncryptionAvailable()) throw new Error('Windows encrypted credential storage is not available');
  const path = join(HERE, 'siwc-devkit', 'packages', 'local', 'dist', 'index.js');
  const sdk = await import(pathToFileURL(path).href);
  client = sdk.createChatGPT({
    appName: 'WeFlow Personal AI',
    appId: 'weflow-personal-ai',
    redirectPort: 0,
    sendHostId: true,
    storageDir: join(app.getPath('userData'), 'chatgpt'),
    credentialEncryption: credentialEncryption(),
    openBrowser: async target => {
      const url = new URL(target);
      if (url.origin !== 'https://auth.openai.com') throw new Error('Unexpected sign-in host');
      await shell.openExternal(url.toString());
    },
  });
  const sessionStore = encryptedSessionStore({
    filePath: join(app.getPath('userData'), 'browser-session.enc'),
    encrypt: async text => {
      if (!safeStorage.isEncryptionAvailable()) throw new Error('OS encryption unavailable');
      return safeStorage.encryptString(text);
    },
    decrypt: async bytes => {
      if (!safeStorage.isEncryptionAvailable()) throw new Error('OS encryption unavailable');
      return safeStorage.decryptString(bytes);
    },
  });
  const bridge = createBridge({ client, sessionStore, confirmPairing });
  await bridge.restore();
  installIpc();
  server = createServer(bridge.listener);
  server.on('error', error => {
    const message = error.code === 'EADDRINUSE'
      ? 'Another WeFlow AI bridge is already running. Close it first.'
      : 'Failed to start local AI bridge.';
    console.error(message);
    mainWindow?.webContents.send('bridge-error', message);
    app.quit();
  });
  server.listen(AI_PORT, '127.0.0.1', () => {
    console.log('WeFlow AI background bridge ready on 127.0.0.1:' + AI_PORT);
    // only a bridge that serves gets a tray icon: one that could not listen leaves at once
    createTray();
    if (process.argv.includes('--show-panel')) createPanel();
  });
}

// A second copy could not listen anyway; leaving at once keeps it from touching the credential files.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.whenReady().then(boot).catch(error => {
    console.error('Unable to initialize the personal AI bridge:', error.message);
    app.quit();
  });
}
// The bridge stays running in the background even if the optional status window closes.
app.on('window-all-closed', () => {});
app.on('before-quit', () => { tray?.destroy(); server?.close(); });
