import { app, BrowserWindow, session, ipcMain, safeStorage, dialog } from 'electron';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { fork } from 'child_process';
import http from 'http';
import fs from 'fs';
import net from 'net';
import ffmpegPath from 'ffmpeg-static-electron';
import ffprobePath from 'ffprobe-static-electron';
import {
  emptyStore,
  parseStore,
  serializeStore,
  setSecret,
  clearSecret,
  hasSecret,
  readSecret,
} from './electron/keyStore.cjs';

// Electron 31's V8 pointer-compression cage is 4 GB. A larger value is ignored.
// See src/services/memoryLimits.ts. This does not replace streaming or paging.
app.commandLine.appendSwitch('js-flags', '--max-old-space-size=4096');

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Keep the existing database and settings in %APPDATA%\react-example even though
// productName is "Narrative AI".
app.setPath('userData', path.join(app.getPath('appData'), 'react-example'));

let mainWindow = null;
let splashWindow = null;
let serverProcess = null;
let serverPort = null;
const sessionToken = crypto.randomBytes(32).toString('hex');

const logDir = app.getPath('userData');
if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
const logPath = path.join(logDir, 'server-log.txt');
const logStream = fs.createWriteStream(logPath, { flags: 'a' });
const secretsPath = path.join(logDir, 'secret-keys.json');

let secretStore = emptyStore();
const plainKeys = { assemblyai: '', gemini: '' };

function logMemory(reason) {
  const usage = process.memoryUsage();
  let metrics = "";
  try {
    metrics = app.getAppMetrics()
      .map((entry) => `${entry.type}:${entry.pid}:ws=${entry.memory && entry.memory.workingSetSize || 0}`)
      .join(" ");
  } catch (err) {
    metrics = "metrics-unavailable";
  }
  log(`[memory] ${reason} rss=${usage.rss} heapUsed=${usage.heapUsed} external=${usage.external} ${metrics}`);
}

function showRecovery(reason) {
  log(`[crash] ${reason}`);
  try { logMemory("crash"); } catch (err) {}
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.show();
  mainWindow.webContents.loadFile(path.join(__dirname, "recovery.html"), {
    query: { reason: String(reason).slice(0, 300) },
  }).catch((err) => log(`Recovery page failed: ${err.message}`));
}

function allowPaths(paths) {
  return new Promise((resolve) => {
    if (!serverProcess || !serverProcess.connected) {
      resolve(false);
      return;
    }
    const id = crypto.randomBytes(8).toString("hex");
    const timer = setTimeout(() => {
      serverProcess.removeListener("message", onMessage);
      resolve(false);
    }, 2000);
    const onMessage = (msg) => {
      if (msg && msg.type === "paths-allowed" && msg.id === id) {
        clearTimeout(timer);
        serverProcess.removeListener("message", onMessage);
        resolve(true);
      }
    };
    serverProcess.on("message", onMessage);
    serverProcess.send({ type: "allow-paths", id, paths });
  });
}

function log(message) {
  const timestamp = new Date().toISOString();
  const formattedMsg = `[${timestamp}] ${message}\n`;
  logStream.write(formattedMsg);
  console.log(formattedMsg);
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function cipher() {
  return {
    encrypt(plain) {
      if (!safeStorage.isEncryptionAvailable()) {
        throw new Error('Electron safeStorage encryption is not available on this computer.');
      }
      return safeStorage.encryptString(plain).toString('base64');
    },
    decrypt(payload) {
      if (!safeStorage.isEncryptionAvailable()) {
        throw new Error('Electron safeStorage encryption is not available on this computer.');
      }
      return safeStorage.decryptString(Buffer.from(payload, 'base64'));
    },
  };
}

function loadSecrets() {
  try {
    if (!fs.existsSync(secretsPath)) return;
    secretStore = parseStore(fs.readFileSync(secretsPath, 'utf8'));
    plainKeys.assemblyai = readSecret(secretStore, 'assemblyai', cipher()) || '';
    plainKeys.gemini = readSecret(secretStore, 'gemini', cipher()) || '';
    log(`Loaded encrypted keys (assemblyai=${plainKeys.assemblyai ? 'set' : 'empty'}, gemini=${plainKeys.gemini ? 'set' : 'empty'})`);
  } catch (err) {
    log(`Failed to read encrypted keys: ${err.message}`);
  }
}

function writeSecrets() {
  fs.writeFileSync(secretsPath, serializeStore(secretStore), { mode: 0o600 });
}

function pushSecrets() {
  if (serverProcess && serverProcess.connected) {
    serverProcess.send({ type: 'secrets', assemblyai: plainKeys.assemblyai, gemini: plainKeys.gemini });
  }
}

log('--- APP SESSION START ---');
log(`App Path: ${app.getAppPath()}`);
log(`UserData Path: ${logDir}`);
log(`Is Packaged: ${app.isPackaged}`);

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
    server.on('error', reject);
  });
}

function httpGet(url, headers) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { headers }, (res) => {
      res.resume();
      resolve(res);
    });
    req.on('error', reject);
  });
}

function createSplashWindow() {
  splashWindow = new BrowserWindow({
    width: 500,
    height: 400,
    transparent: true,
    frame: false,
    alwaysOnTop: true,
    icon: path.join(__dirname, 'icon.png'),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  splashWindow.loadFile(path.join(__dirname, 'splash.html'));
  splashWindow.on('closed', () => {
    splashWindow = null;
  });
}

function startServer(port) {
  serverPort = port;
  const isDev = !app.isPackaged;
  const serverPath = isDev
    ? path.join(__dirname, 'server.ts')
    : path.join(process.resourcesPath, 'app.asar.unpacked', 'server.cjs');

  log(`Target Server Path: ${serverPath}`);

  const ffmpegFixedPath = isDev
    ? ffmpegPath.path
    : ffmpegPath.path.replace('app.asar', 'app.asar.unpacked');
  const ffprobeFixedPath = isDev
    ? ffprobePath.path
    : ffprobePath.path.replace('app.asar', 'app.asar.unpacked');

  const env = {
    ...process.env,
    NODE_ENV: isDev ? 'development' : 'production',
    PORT: port.toString(),
    APP_PATH: app.getAppPath(),
    APP_USER_DATA_PATH: app.getPath('userData'),
    FFMPEG_PATH: ffmpegFixedPath,
    FFPROBE_PATH: ffprobeFixedPath,
    ELECTRON_RUN_AS_NODE: '1',
    LOCAL_AUTH_TOKEN: sessionToken,
    NODE_OPTIONS: [process.env.NODE_OPTIONS, "--max-old-space-size=4096"].filter(Boolean).join(" "),
  };
  delete env.ASSEMBLY_AI_API_KEY;
  delete env.GEMINI_API_KEY;

  const args = isDev ? [serverPath] : ['--production'];

  try {
    if (isDev) {
      serverProcess = fork(
        path.join(__dirname, 'node_modules', 'tsx', 'dist', 'cli.mjs'),
        args,
        { env, stdio: ['inherit', 'pipe', 'pipe', 'ipc'] }
      );
    } else {
      serverProcess = fork(serverPath, args, { env, stdio: ['inherit', 'pipe', 'pipe', 'ipc'] });
    }

    if (serverProcess.stdout) serverProcess.stdout.on('data', (data) => log(`[SERVER]: ${data}`));
    if (serverProcess.stderr) serverProcess.stderr.on('data', (data) => log(`[SERVER ERROR]: ${data}`));

    serverProcess.on('message', (msg) => {
      if (msg && msg.type === 'server-ready') pushSecrets();
    });
    serverProcess.on('error', (err) => log(`CRITICAL: Failed to fork server process: ${err.message}`));
    serverProcess.on('exit', (code) => log(`Server process exited with code ${code}`));
  } catch (err) {
    log(`CRITICAL: Error during server start: ${err.message}`);
  }
}

function createWindow(port) {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    show: false,
    title: 'Narrative AI',
    icon: path.join(__dirname, 'icon.png'),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      nodeIntegrationInPreload: false,
      preload: path.join(__dirname, 'preload.cjs'),
      webSecurity: true,
      allowRunningInsecureContent: false,
    },
  });

  app.on('certificate-error', (event, webContents, url, error, certificate, callback) => {
    if (url.startsWith('http://127.0.0.1')) {
      event.preventDefault();
      callback(true);
    } else {
      callback(false);
    }
  });

  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.control && input.shift && input.key.toLowerCase() === 'i') {
      mainWindow.webContents.openDevTools();
      event.preventDefault();
    }
  });

  const url = `http://127.0.0.1:${port}`;
  const healthUrl = `${url}/health`;

  const waitForServerAndLoad = () => {
    let attempts = 0;
    const maxAttempts = 60;

    const checkServer = () => {
      if (!mainWindow || mainWindow.isDestroyed()) return;
      attempts++;
      httpGet(healthUrl, { Authorization: `Bearer ${sessionToken}` }).then((res) => {
        log(`Server responded! (Status: ${res.statusCode}). Loading window...`);
        if (splashWindow && !splashWindow.isDestroyed()) {
          splashWindow.webContents.executeJavaScript('window.completeLoading()').catch(() => {});
        }
        setTimeout(() => {
          if (!mainWindow || mainWindow.isDestroyed()) return;
          mainWindow.loadURL(url).then(() => {
            log('Main window URL loaded successfully.');
            if (splashWindow && !splashWindow.isDestroyed()) splashWindow.close();
            mainWindow.show();
          }).catch((err) => {
            log(`Failed to load URL: ${err.message}. Retrying...`);
            setTimeout(checkServer, 1000);
          });
        }, 500);
      }).catch((err) => {
        if (attempts > maxAttempts) {
          log('CRITICAL: Server failed to start in time.');
          if (splashWindow && !splashWindow.isDestroyed()) splashWindow.close();
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.loadURL(`data:text/html,<h1>Server Error</h1><p>The backend server failed to start. Error: ${escapeHtml(err.message)}</p><p>Check the log file at: ${escapeHtml(logPath)}</p>`);
            mainWindow.show();
          }
          return;
        }
        if (mainWindow && !mainWindow.isDestroyed()) setTimeout(checkServer, 1000);
      });
    };

    checkServer();
  };

  mainWindow.webContents.on("render-process-gone", (_event, details) => {
    if (details.reason === "clean-exit") return;
    log(`render-process-gone reason=${details.reason} exit=${details.exitCode}`);
    setTimeout(() => showRecovery(`The window stopped (${details.reason}). Your cases are still on this computer.`), 300);
  });

  waitForServerAndLoad();
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function registerIpc() {
  ipcMain.handle('secrets:set', (_event, name, value) => {
    try {
      if (name !== 'assemblyai' && name !== 'gemini') return { ok: false, error: 'Unknown key.' };
      secretStore = setSecret(secretStore, name, String(value || ''), cipher());
      writeSecrets();
      plainKeys[name] = String(value || '').trim();
      pushSecrets();
      return { ok: true };
    } catch (err) {
      log(`Failed to store ${name} key: ${err.message}`);
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('secrets:clear', (_event, name) => {
    try {
      if (name !== 'assemblyai' && name !== 'gemini') return { ok: false, error: 'Unknown key.' };
      secretStore = clearSecret(secretStore, name);
      writeSecrets();
      plainKeys[name] = '';
      pushSecrets();
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('secrets:has', (_event, name) => {
    if (name !== 'assemblyai' && name !== 'gemini') return false;
    return hasSecret(secretStore, name);
  });

  ipcMain.handle('session:token', () => sessionToken);

  ipcMain.handle('app:reload', () => {
    if (mainWindow && !mainWindow.isDestroyed() && serverPort) {
      return mainWindow.loadURL(`http://127.0.0.1:${serverPort}`);
    }
  });

  ipcMain.handle('files:allow', async (_event, filePath) => {
    try {
      const resolved = path.resolve(String(filePath || ""));
      if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
        return { ok: false, error: "Choose a recording file." };
      }
      const allowed = await allowPaths([resolved]);
      if (!allowed) return { ok: false, error: "The local server did not accept that file." };
      return { ok: true, path: resolved };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('files:pick', async () => {
    const result = await dialog.showOpenDialog({
      title: "Add recordings",
      properties: ["openFile", "multiSelections"],
      filters: [{ name: "Recordings", extensions: ["mp3", "wav", "m4a", "aac", "flac", "ogg", "wma", "mp4", "mov", "avi", "mkv", "webm", "mpg"] }],
    });
    if (result.canceled) return [];
    const paths = result.filePaths.map((filePath) => path.resolve(filePath));
    await allowPaths(paths);
    return paths;
  });

  ipcMain.handle('export:pdf', async (_event, payload) => {
    const win = new BrowserWindow({
      show: false,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
    });
    const tmp = path.join(app.getPath('temp'), `narrative-report-${Date.now()}.html`);
    try {
      fs.writeFileSync(tmp, payload?.html || '', 'utf8');
      await win.loadFile(tmp);
      const pdf = await win.webContents.printToPDF({
        printBackground: true,
        pageSize: 'Letter',
        displayHeaderFooter: true,
        headerTemplate: `<div style="font-size:8px;width:100%;padding:0 0.5in;font-family:Arial,sans-serif;">${escapeHtml(payload?.headerText || '')}</div>`,
        footerTemplate: `<div style="font-size:8px;width:100%;padding:0 0.45in;color:#333;font-family:Arial,sans-serif;">
          <div style="font-style:italic;">${escapeHtml(payload?.footerNote || '')}</div>
          <div>${escapeHtml(payload?.auditLine || '')}</div>
          <div style="text-align:right;">Page <span class="pageNumber"></span> of <span class="totalPages"></span></div>
        </div>`,
        margins: { top: 0.7, bottom: 0.9, left: 0.6, right: 0.6 },
      });
      const { canceled, filePath } = await dialog.showSaveDialog({
        defaultPath: payload?.defaultFilename || 'Narrative-AI-report.pdf',
        filters: [{ name: 'PDF', extensions: ['pdf'] }],
      });
      if (canceled || !filePath) return { canceled: true };
      fs.writeFileSync(filePath, pdf);
      return { canceled: false, filePath };
    } catch (err) {
      log(`PDF export failed: ${err.message}`);
      return { canceled: false, error: err.message };
    } finally {
      try { fs.unlinkSync(tmp); } catch (e) {}
      if (!win.isDestroyed()) win.destroy();
    }
  });
}

const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.on('ready', async () => {
    loadSecrets();
    registerIpc();
    session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
      const allowed = ['media', 'audioCapture', 'videoCapture'];
      callback(allowed.includes(permission));
    });

    app.on("child-process-gone", (_event, details) => {
      log(`child-process-gone type=${details.type} reason=${details.reason} exit=${details.exitCode}`);
      try { logMemory("child-process-gone"); } catch (err) {}
      if (details.reason === "clean-exit") return;
      showRecovery(`A background process stopped (${details.type}: ${details.reason}).`);
    });
    const memoryTimer = setInterval(() => logMemory("interval"), 60_000);
    if (memoryTimer.unref) memoryTimer.unref();

    createSplashWindow();
    try {
      const port = await getFreePort();
      startServer(port);
      createWindow(port);
    } catch (err) {
      log(`CRITICAL: Failed to get port or start: ${err.message}`);
      app.quit();
    }
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      if (serverProcess) serverProcess.kill();
      app.quit();
    }
  });

  app.on('activate', () => {
    if (mainWindow === null && serverPort !== null) createWindow(serverPort);
  });
}

process.on('exit', () => {
  if (serverProcess) serverProcess.kill();
});
