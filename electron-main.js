const { app, BrowserWindow, dialog, ipcMain, screen, shell } = require('electron');
const { autoUpdater: releaseUpdater } = require('electron-updater');
const fs = require('node:fs/promises');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const DISCORD_APP_ID = '1573710172520587314';
const RELEASES_URL = 'https://github.com/YEA1233/alone-workers/releases/latest';
const GAME_VERSION = require('./package.json').gameVersion;
if (!/^\d+\.\d+\.\d+\.\d+$/.test(GAME_VERSION)) throw new Error('gameVersion must use four numeric components.');
const CURRENT_RELEASE = {
  id: 'current',
  title: 'ALONE TOGETHER',
  version: GAME_VERSION,
  channel: 'LATEST',
  description: 'The current full survival game.',
  relativePath: path.join('public', 'Alone.html')
};
const WINDOW_SIZES = [
  { width: 1280, height: 720 },
  { width: 1600, height: 900 },
  { width: 1920, height: 1080 },
  { width: 2560, height: 1440 }
];
const THEMES = ['system', 'dark', 'light'];
const DEFAULT_OPTIONS = {
  width: 1280,
  height: 720,
  fullscreen: false,
  discordEnabled: false,
  theme: 'system',
  launchAtStartup: false,
  setupComplete: false
};
const DEFAULT_UPDATE_STATUS = { status: 'checking', message: 'Checking for launcher updates…' };
let desktopOptions = { ...DEFAULT_OPTIONS };
let launcherWindow;
let gameWindow;
let isQuitting = false;
let releaseCatalog;
let discordSocket;
let discordBuffer = Buffer.alloc(0);
let discordRetryTimer;
let discordHandshakeTimer;
let discordConnected = false;
let discordLastError = '';
let discordPresence = 'In the main menu';
const discordStartedAt = Date.now();
let windowSaveTimer;
let updateStatus = { ...DEFAULT_UPDATE_STATUS };

function getRecommendedWindowSize() {
  const { width, height } = screen.getPrimaryDisplay().workAreaSize;
  return {
    width: Math.max(640, Math.min(1280, width - 48)),
    height: Math.max(480, Math.min(720, height - 80))
  };
}

function getWindowSizes() {
  const sizes = [...WINDOW_SIZES, getRecommendedWindowSize()];
  return [...new Map(sizes.map(size => [`${size.width}x${size.height}`, size])).values()];
}

function isValidWindowSize(width, height) {
  return Number.isInteger(width) && width >= 640 && width <= 7680 &&
    Number.isInteger(height) && height >= 480 && height <= 4320;
}

function validOptions(value) {
  if (!value || typeof value !== 'object') return { ...DEFAULT_OPTIONS };
  const width = Number(value.width);
  const height = Number(value.height);
  const validBounds = Number.isInteger(width) && width >= 640 && width <= 7680 &&
    Number.isInteger(height) && height >= 480 && height <= 4320;
  return {
    width: validBounds ? width : DEFAULT_OPTIONS.width,
    height: validBounds ? height : DEFAULT_OPTIONS.height,
    fullscreen: value.fullscreen === true,
    discordEnabled: value.discordEnabled === true,
    theme: THEMES.includes(value.theme) ? value.theme : DEFAULT_OPTIONS.theme,
    launchAtStartup: value.launchAtStartup === true,
    setupComplete: value.setupComplete === true
  };
}

function optionsPath() {
  return path.join(app.getPath('userData'), 'desktop-options.json');
}

function activeWindow() {
  return gameWindow && !gameWindow.isDestroyed() ? gameWindow : launcherWindow;
}

async function persistOptions() {
  const file = optionsPath();
  const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(temporary, JSON.stringify(desktopOptions, null, 2), 'utf8');
  await fs.rename(temporary, file);
}

async function loadOptions() {
  try {
    desktopOptions = validOptions(JSON.parse(await fs.readFile(optionsPath(), 'utf8')));
  } catch (error) {
    if (error.code !== 'ENOENT') console.error('Could not read desktop options:', error);
    desktopOptions = { ...DEFAULT_OPTIONS, ...getRecommendedWindowSize() };
  }
}

function saveWindowSizeSoon() {
  const window = gameWindow;
  if (!window || window.isDestroyed() || window.isFullScreen() || window.isMaximized()) return;
  const { width, height } = window.getBounds();
  desktopOptions.width = width;
  desktopOptions.height = height;
  clearTimeout(windowSaveTimer);
  windowSaveTimer = setTimeout(() => {
    persistOptions().catch(error => console.error('Could not save window size:', error));
  }, 300);
}

function saveId(value) {
  const id = String(value || '');
  if (!/^[a-zA-Z0-9_-]{1,80}$/.test(id)) throw new Error('Invalid save slot ID.');
  return id;
}

function saveDirectory() {
  return path.join(app.getPath('userData'), 'saves');
}

function savePath(id) {
  return path.join(saveDirectory(), `${saveId(id)}.json`);
}

async function getReleaseCatalog() {
  if (releaseCatalog) return releaseCatalog;
  const releaseRoot = app.isPackaged ? process.resourcesPath : __dirname;
  const legacyDirectory = path.join(releaseRoot, 'legacy');
  const entries = await fs.readdir(legacyDirectory, { withFileTypes: true });
  const legacyReleases = await Promise.all(entries
    .filter(entry => entry.isFile() && path.extname(entry.name).toLowerCase() === '.html')
    .map(async entry => {
      const filename = entry.name;
      const baseName = filename.replace(/\.html$/i, '').replace(/\s*\([^)]*\)\s*$/, '').trim();
      const title = baseName.toLowerCase().startsWith('zombz') ? 'ZOMBZ Survival' : 'ALONE';
      const versionMatch = filename.match(/\bv(\d+(?:\.\d+){0,3})\b/i);
      const version = versionMatch
        ? [...versionMatch[1].split('.'), '0', '0', '0'].slice(0, 4).join('.')
        : '0.0.0.0';
      const versioned = Boolean(versionMatch);
      const augustArchive = /august 2026/i.test(filename);
      return {
        id: `legacy-${Buffer.from(filename, 'utf8').toString('base64url')}`,
        title: versioned ? title : `${title} — ${augustArchive ? 'August 2026' : 'unversioned'} archive`,
        version,
        channel: versioned ? 'LEGACY' : 'ARCHIVE',
        description: versioned
          ? 'Historical release kept in the desktop archive.'
          : augustArchive ? 'Unversioned build from around August 2026.' : 'Unversioned historical build.',
        relativePath: path.join('legacy', filename)
      };
    }));
  releaseCatalog = [CURRENT_RELEASE, ...legacyReleases];
  return releaseCatalog;
}

function discordSocketPaths() {
  if (process.platform === 'win32') {
    return Array.from({ length: 10 }, (_, index) => `\\\\?\\pipe\\discord-ipc-${index}`);
  }

  const paths = [];
  if (process.env.DISCORD_IPC_PATH) paths.push(process.env.DISCORD_IPC_PATH);
  if (process.platform === 'darwin') {
    for (const client of ['discord', 'discord-canary', 'discord-ptb']) {
      for (let index = 0; index < 10; index++) {
        paths.push(path.join(os.homedir(), 'Library', 'Application Support', client, `discord-ipc-${index}`));
      }
    }
  } else {
    const runtimeDirs = [
      process.env.XDG_RUNTIME_DIR,
      typeof process.getuid === 'function' ? `/run/user/${process.getuid()}` : null,
      os.tmpdir(),
      '/tmp'
    ].filter(Boolean);
    for (const directory of new Set(runtimeDirs)) {
      for (let index = 0; index < 10; index++) paths.push(path.join(directory, `discord-ipc-${index}`));
    }
  }
  return [...new Set(paths)];
}

function writeDiscordPacket(opcode, payload) {
  if (!discordSocket || discordSocket.destroyed) return;
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  const header = Buffer.alloc(8);
  header.writeInt32LE(opcode, 0);
  header.writeInt32LE(body.length, 4);
  discordSocket.write(Buffer.concat([header, body]));
}

function sendDiscordActivity() {
  if (!discordConnected) return;
  writeDiscordPacket(1, {
    cmd: 'SET_ACTIVITY',
    args: {
      pid: process.pid,
      activity: {
        details: 'Surviving in ALONE',
        state: discordPresence.slice(0, 128),
        timestamps: { start: discordStartedAt },
        instance: false
      }
    },
    nonce: crypto.randomUUID()
  });
}

function closeDiscordSocket() {
  clearTimeout(discordHandshakeTimer);
  discordHandshakeTimer = null;
  if (discordSocket) {
    discordSocket.removeAllListeners();
    discordSocket.destroy();
    discordSocket = null;
  }
  discordBuffer = Buffer.alloc(0);
  discordConnected = false;
}

function scheduleDiscordRetry() {
  if (!desktopOptions.discordEnabled || discordRetryTimer) return;
  discordRetryTimer = setTimeout(() => {
    discordRetryTimer = null;
    connectDiscord();
  }, 5000);
  discordRetryTimer.unref?.();
}

function handleDiscordPacket(opcode, data) {
  if (opcode === 3) {
    writeDiscordPacket(4, data);
    return;
  }
  if (opcode !== 1) return;
  if (data.evt === 'READY') {
    clearTimeout(discordHandshakeTimer);
    discordConnected = true;
    discordLastError = '';
    sendDiscordActivity();
  } else if (data.evt === 'ERROR' || data.data?.code) {
    discordLastError = data.data?.message || 'Discord rejected the Rich Presence update.';
    console.warn(discordLastError);
  }
}

function connectDiscord() {
  closeDiscordSocket();
  if (!desktopOptions.discordEnabled) return;

  const paths = discordSocketPaths();
  let index = 0;
  const tryNext = () => {
    if (!desktopOptions.discordEnabled) return;
    if (index >= paths.length) {
      discordLastError = 'Discord is not running or its IPC socket is unavailable.';
      scheduleDiscordRetry();
      return;
    }

    const socket = net.createConnection(paths[index++]);
    discordSocket = socket;
    let connected = false;
    socket.once('connect', () => {
      connected = true;
      discordHandshakeTimer = setTimeout(() => {
        discordLastError = 'Discord Rich Presence handshake timed out.';
        closeDiscordSocket();
        scheduleDiscordRetry();
      }, 5000);
      writeDiscordPacket(0, { v: 1, client_id: DISCORD_APP_ID });
    });
    socket.on('data', chunk => {
      discordBuffer = Buffer.concat([discordBuffer, chunk]);
      while (discordBuffer.length >= 8) {
        const opcode = discordBuffer.readInt32LE(0);
        const length = discordBuffer.readInt32LE(4);
        if (length < 0 || length > 16 * 1024 * 1024) {
          discordLastError = 'Discord sent an invalid IPC packet.';
          closeDiscordSocket();
          scheduleDiscordRetry();
          return;
        }
        if (discordBuffer.length < 8 + length) return;
        const body = discordBuffer.subarray(8, 8 + length).toString('utf8');
        discordBuffer = discordBuffer.subarray(8 + length);
        try {
          handleDiscordPacket(opcode, JSON.parse(body));
        } catch (error) {
          discordLastError = `Could not read Discord IPC response: ${error.message}`;
          closeDiscordSocket();
          scheduleDiscordRetry();
          return;
        }
      }
    });
    socket.on('error', error => {
      if (!connected) {
        socket.destroy();
        if (discordSocket === socket) discordSocket = null;
        tryNext();
      } else {
        discordLastError = `Discord connection failed: ${error.message}`;
      }
    });
    socket.on('close', () => {
      if (discordSocket === socket) {
        discordSocket = null;
        discordConnected = false;
        scheduleDiscordRetry();
      }
    });
  };
  tryNext();
}

function getDesktopState() {
  return {
    windowSizes: getWindowSizes(),
    width: desktopOptions.width,
    height: desktopOptions.height,
    fullscreen: gameWindow && !gameWindow.isDestroyed()
      ? gameWindow.isFullScreen()
      : desktopOptions.fullscreen,
    discordEnabled: desktopOptions.discordEnabled,
    discordConnected,
    discordError: discordLastError,
    theme: desktopOptions.theme,
    launchAtStartup: desktopOptions.launchAtStartup,
    setupComplete: desktopOptions.setupComplete,
    supportsLoginItem: process.platform === 'win32' || process.platform === 'darwin',
    updateStatus
  };
}

function publishUpdateStatus(status, message, metadata = {}) {
  updateStatus = { status, message, ...metadata };
  if (launcherWindow && !launcherWindow.isDestroyed()) {
    launcherWindow.webContents.send('desktop:update-status', updateStatus);
  }
  return updateStatus;
}

function isPortableBuild() {
  return Boolean(process.env.PORTABLE_EXECUTABLE_FILE || process.env.PORTABLE_EXECUTABLE_DIR);
}

async function supportsLinuxUpdates() {
  if (process.env.APPIMAGE) return true;
  try {
    const packageType = (await fs.readFile(path.join(process.resourcesPath, 'package-type'), 'utf8')).trim();
    return ['deb', 'rpm', 'pacman'].includes(packageType);
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

async function checkForUpdates() {
  if (!app.isPackaged) {
    return publishUpdateStatus('unsupported', 'Update checks are available in installed releases.');
  }
  if (process.platform === 'win32' && isPortableBuild()) {
    return publishUpdateStatus('manual', 'Portable builds must be updated by downloading the latest release.');
  }
  if (process.platform === 'linux' && !(await supportsLinuxUpdates())) {
    return publishUpdateStatus('manual', 'Install the DEB or RPM package to enable launcher updates.');
  }
  if (process.platform !== 'win32' && process.platform !== 'linux') {
    return publishUpdateStatus('manual', 'Launcher updates are not supported for this installation.');
  }
  publishUpdateStatus('checking', 'Checking for launcher updates…');
  try {
    await releaseUpdater.checkForUpdates();
    return updateStatus;
  } catch (error) {
    publishUpdateStatus('error', `Update check failed: ${error.message}`);
    throw error;
  }
}

releaseUpdater.autoDownload = false;
releaseUpdater.autoInstallOnAppQuit = false;
releaseUpdater.on('checking-for-update', () => {
  publishUpdateStatus('checking', 'Checking for launcher updates…');
});
releaseUpdater.on('update-available', info => {
  publishUpdateStatus('available', `Version ${info.version} is available.`, { version: info.version });
});
releaseUpdater.on('update-not-available', () => {
  publishUpdateStatus('current', 'The launcher is up to date.');
});
releaseUpdater.on('download-progress', progress => {
  publishUpdateStatus('downloading', `Downloading update: ${Math.round(progress.percent)}%`, {
    percent: progress.percent
  });
});
releaseUpdater.on('update-downloaded', info => {
  publishUpdateStatus('downloaded', `Version ${info.version} is ready to install.`, { version: info.version });
});
releaseUpdater.on('error', error => {
  publishUpdateStatus('error', `Update failed: ${error.message}`);
});

ipcMain.handle('desktop:get-state', () => getDesktopState());

ipcMain.handle('desktop:complete-setup', async (_event, settings) => {
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
    throw new Error('Setup settings are invalid.');
  }
  const width = Number(settings.width);
  const height = Number(settings.height);
  if (!isValidWindowSize(width, height)) throw new Error('Choose a supported window size.');
  if (typeof settings.fullscreen !== 'boolean') throw new Error('Fullscreen setting must be on or off.');
  if (typeof settings.theme !== 'string' || !THEMES.includes(settings.theme)) {
    throw new Error('Choose a supported launcher theme.');
  }
  if (typeof settings.launchAtStartup !== 'boolean') throw new Error('Startup setting must be on or off.');

  desktopOptions = {
    ...desktopOptions,
    width,
    height,
    fullscreen: settings.fullscreen,
    theme: settings.theme,
    launchAtStartup: settings.launchAtStartup && (process.platform === 'win32' || process.platform === 'darwin'),
    setupComplete: true
  };
  if (process.platform === 'win32' || process.platform === 'darwin') {
    app.setLoginItemSettings({ openAtLogin: desktopOptions.launchAtStartup, path: process.execPath });
  }
  await persistOptions();
  return getDesktopState();
});

ipcMain.handle('desktop:set-theme', async (_event, theme) => {
  if (typeof theme !== 'string' || !THEMES.includes(theme)) throw new Error('Choose a supported launcher theme.');
  desktopOptions.theme = theme;
  await persistOptions();
  return getDesktopState();
});

ipcMain.handle('desktop:set-launch-at-startup', async (_event, enabled) => {
  if (typeof enabled !== 'boolean') throw new Error('Startup setting must be on or off.');
  if (process.platform !== 'win32' && process.platform !== 'darwin') {
    throw new Error('Launch at startup is not supported on this platform.');
  }
  desktopOptions.launchAtStartup = enabled;
  app.setLoginItemSettings({ openAtLogin: enabled, path: process.execPath });
  await persistOptions();
  return getDesktopState();
});

ipcMain.handle('desktop:updates:get-state', () => updateStatus);
ipcMain.handle('desktop:updates:check', () => checkForUpdates());
ipcMain.handle('desktop:updates:download', async () => {
  if (updateStatus.status !== 'available') throw new Error('There is no available update to download.');
  try {
    await releaseUpdater.downloadUpdate();
    return updateStatus;
  } catch (error) {
    publishUpdateStatus('error', `Update download failed: ${error.message}`);
    throw error;
  }
});
ipcMain.handle('desktop:updates:install', () => {
  if (updateStatus.status !== 'downloaded') throw new Error('The update has not finished downloading.');
  if (gameWindow && !gameWindow.isDestroyed()) throw new Error('Close the running game before installing the update.');
  releaseUpdater.quitAndInstall(false, true);
});
ipcMain.handle('desktop:updates:open-releases', () => shell.openExternal(RELEASES_URL));

ipcMain.handle('launcher:list-releases', async () => (await getReleaseCatalog()).map(release => ({
  id: release.id,
  title: release.title,
  version: release.version,
  channel: release.channel,
  description: release.description
})));

ipcMain.handle('launcher:launch-release', async (_event, id) => {
  if (typeof id !== 'string') throw new Error('Choose a game version to launch.');
  const release = (await getReleaseCatalog()).find(item => item.id === id);
  if (!release) throw new Error('That game version is not available.');
  if (gameWindow && !gameWindow.isDestroyed()) {
    gameWindow.focus();
    return { alreadyRunning: true };
  }

  const releaseRoot = release.id === 'current'
    ? __dirname
    : app.isPackaged ? process.resourcesPath : __dirname;
  const resolvedRoot = path.resolve(releaseRoot);
  const resolvedReleasePath = path.resolve(releaseRoot, release.relativePath);
  if (!resolvedReleasePath.startsWith(`${resolvedRoot}${path.sep}`)) throw new Error('Invalid release path.');
  await fs.access(resolvedReleasePath);

  gameWindow = new BrowserWindow({
    width: desktopOptions.width,
    height: desktopOptions.height,
    minWidth: 640,
    minHeight: 480,
    title: `${release.title} · ${release.version}`,
    frame: true,
    show: false,
    autoHideMenuBar: true,
    icon: path.join(__dirname, 'public', 'favicon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'electron-preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true
    }
  });

  gameWindow.once('ready-to-show', () => {
    if (!gameWindow || gameWindow.isDestroyed()) return;
    gameWindow.show();
    if (desktopOptions.fullscreen) gameWindow.setFullScreen(true);
    launcherWindow?.hide();
  });
  gameWindow.on('resize', saveWindowSizeSoon);
  gameWindow.on('closed', () => {
    gameWindow = null;
    if (!isQuitting && launcherWindow && !launcherWindow.isDestroyed()) {
      discordPresence = 'Browsing game versions';
      sendDiscordActivity();
      launcherWindow.show();
      launcherWindow.focus();
    }
  });
  gameWindow.webContents.on('did-fail-load', (_event, code, description) => {
    if (code === -3) return;
    dialog.showErrorBox('Could not launch ALONE', `${release.version}: ${description}`);
    gameWindow?.close();
  });
  await gameWindow.loadFile(resolvedReleasePath);
  return { alreadyRunning: false };
});

ipcMain.handle('desktop:set-window-size', async (_event, width, height) => {
  width = Number(width);
  height = Number(height);
  if (!isValidWindowSize(width, height)) throw new Error('Choose a supported window size.');
  desktopOptions.width = width;
  desktopOptions.height = height;
  const window = gameWindow;
  if (window && !window.isDestroyed()) {
    if (window.isMaximized()) window.unmaximize();
    if (!window.isFullScreen()) window.setSize(width, height, true);
    window.center();
  }
  await persistOptions();
  return getDesktopState();
});

ipcMain.handle('desktop:set-fullscreen', async (_event, enabled) => {
  if (typeof enabled !== 'boolean') throw new Error('Fullscreen setting must be on or off.');
  desktopOptions.fullscreen = enabled;
  const window = gameWindow;
  if (window && !window.isDestroyed()) window.setFullScreen(enabled);
  if (!enabled) {
    setTimeout(() => {
      const currentWindow = gameWindow;
      if (!currentWindow || currentWindow.isDestroyed() || currentWindow.isFullScreen()) return;
      if (currentWindow.isMaximized()) currentWindow.unmaximize();
      currentWindow.setSize(desktopOptions.width, desktopOptions.height, true);
      currentWindow.center();
    }, 100);
  }
  await persistOptions();
  return getDesktopState();
});

ipcMain.handle('desktop:set-discord-enabled', async (_event, enabled) => {
  if (typeof enabled !== 'boolean') throw new Error('Discord Rich Presence setting must be on or off.');
  desktopOptions.discordEnabled = enabled;
  discordLastError = '';
  await persistOptions();
  if (enabled) connectDiscord();
  else {
    clearTimeout(discordRetryTimer);
    discordRetryTimer = null;
    if (discordConnected) writeDiscordPacket(1, {
      cmd: 'SET_ACTIVITY',
      args: { pid: process.pid, activity: null },
      nonce: crypto.randomUUID()
    });
    closeDiscordSocket();
  }
  return getDesktopState();
});

ipcMain.handle('desktop:set-presence', (_event, state) => {
  if (typeof state !== 'string') throw new Error('Presence status must be text.');
  discordPresence = state.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 128) || 'In the main menu';
  sendDiscordActivity();
});

ipcMain.handle('desktop:quit', () => app.quit());

ipcMain.handle('desktop:saves:list', async () => {
  await fs.mkdir(saveDirectory(), { recursive: true });
  const entries = await fs.readdir(saveDirectory(), { withFileTypes: true });
  const saves = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const slotId = entry.name.slice(0, -5);
    saveId(slotId);
    const save = JSON.parse(await fs.readFile(path.join(saveDirectory(), entry.name), 'utf8'));
    if (!save || !Number.isInteger(save.version)) throw new Error(`Saved world "${entry.name}" is invalid.`);
    saves.push({
      slotId,
      slotName: typeof save.slotName === 'string' ? save.slotName : 'Saved world',
      dayCount: Number(save.dayCount) || 1,
      version: save.version
    });
  }
  return saves.sort((a, b) => a.slotName.localeCompare(b.slotName));
});

ipcMain.handle('desktop:saves:read', async (_event, id) => {
  const save = JSON.parse(await fs.readFile(savePath(id), 'utf8'));
  if (!save || typeof save !== 'object') throw new Error('Saved world file is invalid.');
  return save;
});

ipcMain.handle('desktop:saves:write', async (_event, id, save) => {
  id = saveId(id);
  if (!save || typeof save !== 'object' || Array.isArray(save) || !Number.isInteger(save.version)) {
    throw new Error('Refusing to write invalid save data.');
  }
  const file = savePath(id);
  const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await fs.mkdir(saveDirectory(), { recursive: true });
  try {
    await fs.writeFile(temporary, JSON.stringify({ ...save, slotId: id }), 'utf8');
    await fs.rename(temporary, file);
  } catch (error) {
    await fs.rm(temporary, { force: true });
    throw error;
  }
});

ipcMain.handle('desktop:saves:delete', async (_event, id) => {
  await fs.rm(savePath(id), { force: true });
});

ipcMain.handle('desktop:open-save', async () => {
  const result = await dialog.showOpenDialog(activeWindow(), {
    title: 'Open ALONE save',
    properties: ['openFile'],
    filters: [{ name: 'ALONE save files', extensions: ['save', 'json'] }]
  });
  if (result.canceled || !result.filePaths[0]) return null;
  return fs.readFile(result.filePaths[0], 'utf8');
});

ipcMain.handle('desktop:export-save', async (_event, save, filename) => {
  if (!save || typeof save !== 'object' || !Number.isInteger(save.version)) {
    throw new Error('Refusing to export invalid save data.');
  }
  const safeFilename = `${String(filename || 'alone-world').replace(/[^a-z0-9-_]+/gi, '-')}.save`;
  const result = await dialog.showSaveDialog(activeWindow(), {
    title: 'Export ALONE world',
    defaultPath: path.join(app.getPath('documents'), safeFilename),
    filters: [{ name: 'ALONE save files', extensions: ['save'] }]
  });
  if (result.canceled || !result.filePath) return false;
  await fs.writeFile(result.filePath, JSON.stringify(save), { flag: 'w' });
  return true;
});

async function createLauncherWindow() {
  const launcherSize = getRecommendedWindowSize();
  launcherWindow = new BrowserWindow({
    width: launcherSize.width,
    height: launcherSize.height,
    minWidth: 640,
    minHeight: 480,
    title: 'ALONE',
    frame: true,
    show: false,
    autoHideMenuBar: true,
    icon: path.join(__dirname, 'public', 'favicon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'electron-preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true
    }
  });

  launcherWindow.once('ready-to-show', () => launcherWindow.show());
  launcherWindow.on('close', () => {
    clearTimeout(windowSaveTimer);
    persistOptions().catch(error => console.error('Could not save desktop options:', error));
  });
  await launcherWindow.loadFile(path.join(__dirname, 'launcher.html'));
  if (desktopOptions.discordEnabled) connectDiscord();
}

app.whenReady().then(async () => {
  await loadOptions();
  await createLauncherWindow();
  checkForUpdates().catch(error => console.error('Could not check for launcher updates:', error));
}).catch(error => {
  console.error('Could not start ALONE desktop:', error);
  app.exit(1);
});

app.on('before-quit', () => {
  isQuitting = true;
  clearTimeout(discordRetryTimer);
  clearTimeout(discordHandshakeTimer);
  closeDiscordSocket();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (gameWindow && !gameWindow.isDestroyed()) gameWindow.show();
  else if (launcherWindow && !launcherWindow.isDestroyed()) launcherWindow.show();
  else createLauncherWindow();
});
