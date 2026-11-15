import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { app, BrowserWindow, clipboard, dialog, ipcMain, safeStorage, shell } from 'electron';
import { AI_PORT } from './guard.mjs';
import { createBridge } from './server.mjs';
import { encryptedSessionStore } from './session.mjs';

const bridgeToken = randomBytes(32).toString('base64url');
let client;
let mainWindow;
let server;

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
  mainWindow = new BrowserWindow({
    width: 560, height: 440, title: 'WeFlow AI · ChatGPT Pro',
    webPreferences: {
      contextIsolation: true, nodeIntegration: false, sandbox: true,
      preload: join(import.meta.dirname, 'preload.cjs'),
    },
  });
  mainWindow.loadFile(join(import.meta.dirname, 'panel.html'));
  mainWindow.on('closed', () => { mainWindow = null; });
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
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
  ipcMain.handle('bridge-copy-token', async event => {
    verify(event);
    await clipboard.writeText(bridgeToken);
    return true;
  });
  ipcMain.handle('bridge-open-usage', async event => {
    verify(event);
    await shell.openExternal('https://chatgpt.com/settings/usage');
  });
}

async function boot() {
  if (!safeStorage.isEncryptionAvailable()) throw new Error('Windows encrypted credential storage is not available');
  const path = join(import.meta.dirname, 'siwc-devkit', 'packages', 'local', 'dist', 'index.js');
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
  const bridge = createBridge({ client, sessionStore, confirmPairing, bridgeToken });
  await bridge.restore();
  installIpc();
  if (process.argv.includes('--show-panel')) createPanel();
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
// The bridge stays running in the background even if the optional diagnostics panel closes.
app.on('window-all-closed', () => {});
app.on('before-quit', () => server?.close());
