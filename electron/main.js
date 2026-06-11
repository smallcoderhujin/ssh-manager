const { app, BrowserWindow, ipcMain, Menu, shell, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const pty = require('node-pty');
const Store = require('electron-store');
const Zmodem = require('zmodem.js');

const isMac = process.platform === 'darwin';
const isWin = process.platform === 'win32';

// Resolve ssh binary cross-platform
function findSshBinary() {
  if (isWin) {
    const candidates = [
      path.join(process.env['SystemRoot'] || 'C:\\Windows', 'System32', 'OpenSSH', 'ssh.exe'),
      path.join(process.env['ProgramFiles'] || 'C:\\Program Files', 'Git', 'usr', 'bin', 'ssh.exe'),
    ];
    for (const c of candidates) {
      try { fs.accessSync(c); return c; } catch (_) {}
    }
    return 'ssh'; // fallback: rely on PATH
  }
  return '/usr/bin/ssh';
}

const SSH_BINARY = findSshBinary();

// Initialize electron-store
const store = new Store({
  name: 'ssh-sessions',
  defaults: {
    sessions: [],
  },
});

const isDev = process.env.NODE_ENV === 'development' || !app.isPackaged;

// Map of active PTY processes: id -> { pty, window }
const terminals = new Map();
let terminalIdCounter = 0;

function createWindow() {
  const winOptions = {
    width: 1280,
    height: 800,
    minWidth: 800,
    minHeight: 500,
    backgroundColor: '#1e1e1e',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
    show: false,
  };

  if (isMac) {
    winOptions.titleBarStyle = 'hiddenInset';
    winOptions.vibrancy = 'sidebar';
  } else {
    // Windows/Linux: frameless, we draw our own title bar
    winOptions.frame = false;
    winOptions.titleBarStyle = 'hidden';
  }

  const win = new BrowserWindow(winOptions);

  win.once('ready-to-show', () => {
    win.show();
  });

  win.on('close', async (e) => {
    e.preventDefault();
    const activeCount = terminals.size;
    const { response } = await dialog.showMessageBox(win, {
      type: 'question',
      buttons: ['关闭', '取消'],
      defaultId: 0,
      cancelId: 1,
      title: '确认关闭',
      message: '确定要关闭 SSH Manager 吗？',
      detail: activeCount > 0 ? `当前有 ${activeCount} 个活动的终端会话将被断开。` : '',
    });
    if (response === 0) {
      win.destroy();
    }
  });

  // Allow clipboard read for right-click paste
  win.webContents.session.setPermissionRequestHandler((webContents, permission, callback) => {
    if (permission === 'clipboard-read') return callback(true);
    callback(false);
  });

  if (isDev) {
    win.loadURL('http://localhost:5173');
  } else {
    win.loadFile(path.join(__dirname, '../dist/index.html'));
  }

  return win;
}

// Build SSH args from session config
function buildSshArgs(session) {
  const args = [];

  args.push('-o', 'StrictHostKeyChecking=accept-new');
  args.push('-o', 'BatchMode=no');
  args.push('-o', 'PasswordAuthentication=yes');
  args.push('-o', 'PreferredAuthentications=keyboard-interactive,password,publickey');

  if (session.port && session.port !== 22 && session.port !== '22') {
    args.push('-p', String(session.port));
  }

  if (session.identityFile) {
    args.push('-i', session.identityFile);
  }

  if (session.extraArgs) {
    const extra = session.extraArgs.trim().split(/\s+/);
    args.push(...extra);
  }

  const user = session.user || os.userInfo().username;
  args.push(`${user}@${session.host}`);

  return args;
}

// Strip ANSI escape codes from a string for pattern matching
function stripAnsi(str) {
  return str.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\x1b[()][AB012]/g, '').replace(/\r/g, '');
}

// Auto-send password when SSH prompts for it.
// Returns a cleanup function that removes the listener.
function setupPasswordAutofill(ptyProcess, password) {
  if (!password) return () => {};

  // SSH password prompt patterns — covers most SSH servers and locales
  const PROMPT_RE = /password\s*:/i;
  let sent = false;
  // Rolling buffer to handle prompts split across data chunks
  let rollingBuf = '';
  const MAX_BUF = 512;

  const dispose = ptyProcess.onData((data) => {
    const str = Buffer.isBuffer(data) ? data.toString('utf8') : String(data);
    // Strip ANSI codes before matching so control sequences don't interfere
    rollingBuf = (rollingBuf + stripAnsi(str)).slice(-MAX_BUF);
    if (!sent && PROMPT_RE.test(rollingBuf)) {
      sent = true;
      rollingBuf = '';
      // Small delay so the prompt finishes rendering before we write
      setTimeout(() => {
        try { ptyProcess.write(password + '\r'); } catch (_) {}
      }, 120);
    }
  });

  return dispose;
}

// IPC: terminal:create
ipcMain.handle('terminal:create', (event, options) => {
  const id = ++terminalIdCounter;
  const win = BrowserWindow.fromWebContents(event.sender);

  let spawnCommand = SSH_BINARY;
  let spawnArgs = [];

  if (options.quickConnect) {
    // Quick connect: user@host[:port]
    const match = options.quickConnect.match(/^(?:([^@]+)@)?([^:]+)(?::(\d+))?$/);
    if (match) {
      const user = match[1] || os.userInfo().username;
      const host = match[2];
      const port = match[3];
      spawnArgs = [
        '-o', 'StrictHostKeyChecking=accept-new',
        '-o', 'BatchMode=no',
        '-o', 'PasswordAuthentication=yes',
        '-o', 'PreferredAuthentications=keyboard-interactive,password,publickey',
      ];
      if (port) spawnArgs.push('-p', port);
      spawnArgs.push(`${user}@${host}`);
    } else {
      spawnArgs = [
        '-o', 'StrictHostKeyChecking=accept-new',
        '-o', 'BatchMode=no',
        '-o', 'PasswordAuthentication=yes',
        '-o', 'PreferredAuthentications=keyboard-interactive,password,publickey',
        options.quickConnect,
      ];
    }
  } else if (options.sessionConfig) {
    spawnArgs = buildSshArgs(options.sessionConfig);
  } else {
    // Fallback: open a local shell
    if (isWin) {
      spawnCommand = process.env.COMSPEC || 'cmd.exe';
    } else {
      spawnCommand = process.env.SHELL || '/bin/zsh';
    }
    spawnArgs = [];
  }

  const cols = options.cols || 80;
  const rows = options.rows || 24;

  // Write the command to the terminal so it's visible for debugging
  if (win && !win.isDestroyed()) {
    const cmdStr = [spawnCommand, ...spawnArgs].join(' ');
    win.webContents.send('terminal:data', { id, data: `\x1b[2m[Connecting: ${cmdStr}]\x1b[0m\r\n` });
  }

  let ptyProcess;
  try {
    ptyProcess = pty.spawn(spawnCommand, spawnArgs, {
      name: 'xterm-256color',
      cols,
      rows,
      cwd: os.homedir(),
      // binary encoding so Zmodem data passes through correctly
      encoding: null,
      env: {
        ...process.env,
        TERM: 'xterm-256color',
        COLORTERM: 'truecolor',
        LANG: process.env.LANG || 'en_US.UTF-8',
      },
    });
  } catch (err) {
    console.error('Failed to spawn PTY:', err);
    return { error: err.message };
  }

  // Auto-fill password if provided
  const password = options.sessionConfig?.password || options.password || null;
  const disposeAutofill = setupPasswordAutofill(ptyProcess, password);

  // ── Zmodem sentry ────────────────────────────────────────────────────────
  const sentry = new Zmodem.Sentry({
    to_terminal: (octets) => {
      if (win && !win.isDestroyed()) {
        win.webContents.send('terminal:data', { id, data: Buffer.from(octets) });
      }
    },
    sender: (octets) => {
      try { ptyProcess.write(Buffer.from(octets)); } catch (_) {}
    },
    on_retract: () => {
      if (win && !win.isDestroyed()) {
        win.webContents.send('terminal:zmodem', { id, type: 'end' });
      }
    },
    on_detect: (detection) => {
      handleZmodemDetection({ detection, id, win, ptyProcess });
    },
  });

  ptyProcess.onData((data) => {
    // On Windows, node-pty may return strings even with encoding:null.
    // Always normalize to Buffer so sentry.consume() gets proper byte values.
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(String(data));
    try {
      sentry.consume(Array.from(buf));
    } catch (_) {
      // sentry error (e.g. after session ends) — fall back to direct send
      if (win && !win.isDestroyed()) {
        win.webContents.send('terminal:data', { id, data: buf });
      }
    }
  });

  ptyProcess.onExit(({ exitCode, signal }) => {
    disposeAutofill();
    terminals.delete(id);
    if (win && !win.isDestroyed()) {
      win.webContents.send('terminal:exit', { id, exitCode, signal });
    }
  });

  terminals.set(id, { pty: ptyProcess, win });
  return { id };
});

// ── Zmodem detection handler ─────────────────────────────────────────────
async function handleZmodemDetection({ detection, id, win, ptyProcess }) {
  // Correct API: get_session_role() returns 'receive'(sz) or 'send'(rz)
  const role = detection.get_session_role();
  win.webContents.send('terminal:zmodem', { id, type: 'start', direction: role });

  let session;
  try {
    session = detection.confirm();
  } catch (e) {
    console.error('zmodem confirm failed:', e);
    win.webContents.send('terminal:zmodem', { id, type: 'end' });
    return;
  }

  const notify = (payload) => {
    if (win && !win.isDestroyed()) win.webContents.send('terminal:zmodem', { id, ...payload });
  };

  try {
    if (role === 'receive') {
      // sz: server → client (download)
      session.on('offer', async (offer) => {
        const details = offer.get_details();
        const { filePath, canceled } = await dialog.showSaveDialog(win, {
          title: `下载: ${details.name}`,
          defaultPath: path.join(app.getPath('downloads'), details.name),
        });

        if (canceled || !filePath) {
          offer.skip();
          notify({ type: 'end' });
          return;
        }

        const chunks = [];
        offer.on('input', (payload) => {
          chunks.push(Buffer.from(payload));
          const received = chunks.reduce((s, b) => s + b.length, 0);
          notify({ type: 'progress', name: details.name, received, total: details.size || 0 });
        });

        await offer.accept();

        const fileData = Buffer.concat(chunks);
        await fs.promises.writeFile(filePath, fileData);
        notify({ type: 'done', name: details.name, size: fileData.length, savedPath: filePath });
      });

      session.on('session_end', () => notify({ type: 'end' }));

      await session.start();

    } else {
      // rz: client → server (upload)
      const { filePaths, canceled } = await dialog.showOpenDialog(win, {
        title: '选择要上传的文件',
        properties: ['openFile', 'multiSelections'],
      });

      if (canceled || filePaths.length === 0) {
        session.abort();
        notify({ type: 'end' });
        return;
      }

      for (const filePath of filePaths) {
        const fileData = await fs.promises.readFile(filePath);
        const fileName = path.basename(filePath);
        notify({ type: 'progress', name: fileName, received: 0, total: fileData.length });

        const xfer = await session.send_offer({ name: fileName, size: fileData.length, mtime: new Date() });
        if (xfer) {
          const CHUNK = 8192;
          for (let offset = 0; offset < fileData.length; offset += CHUNK) {
            xfer.send(fileData.slice(offset, offset + CHUNK));
            notify({ type: 'progress', name: fileName, received: Math.min(offset + CHUNK, fileData.length), total: fileData.length });
          }
          await xfer.end_and_wait();
        }
        notify({ type: 'done', name: fileName, size: fileData.length });
      }

      session.close();
      notify({ type: 'end' });
    }
  } catch (e) {
    console.error('zmodem transfer error:', e);
    notify({ type: 'end' });
  }
}

// IPC: terminal:write
ipcMain.on('terminal:write', (event, { id, data }) => {
  const term = terminals.get(id);
  if (term) {
    term.pty.write(data);
  }
});

// IPC: terminal:resize
ipcMain.on('terminal:resize', (event, { id, cols, rows }) => {
  const term = terminals.get(id);
  if (term) {
    try {
      term.pty.resize(cols, rows);
    } catch (e) {
      // Ignore resize errors
    }
  }
});

// IPC: terminal:kill
ipcMain.on('terminal:kill', (event, { id }) => {
  const term = terminals.get(id);
  if (term) {
    try {
      term.pty.kill();
    } catch (e) {
      // Ignore kill errors
    }
    terminals.delete(id);
  }
});

// IPC: shell
ipcMain.handle('shell:showItemInFolder', (event, filePath) => shell.showItemInFolder(filePath));

// IPC: show native popup menu (for hamburger button)
ipcMain.on('menu:show-popup', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) return;
  const popupMenu = Menu.buildFromTemplate([
    {
      label: '新建标签页',
      accelerator: 'CmdOrCtrl+T',
      click: () => win.webContents.send('menu:new-tab'),
    },
    { type: 'separator' },
    {
      label: '新建会话',
      click: () => win.webContents.send('menu:add-session'),
    },
    { type: 'separator' },
    {
      label: '导入 SSH Config',
      click: () => win.webContents.send('menu:import-ssh-config'),
    },
    {
      label: '导入会话…',
      click: () => win.webContents.send('menu:import-sessions'),
    },
    {
      label: '导出会话…',
      click: () => win.webContents.send('menu:export-sessions'),
    },
  ]);
  popupMenu.popup({ window: win });
});

// IPC: window controls (Windows/Linux)
ipcMain.on('window:minimize', (e) => BrowserWindow.fromWebContents(e.sender)?.minimize());
ipcMain.on('window:maximize', (e) => {
  const w = BrowserWindow.fromWebContents(e.sender);
  if (!w) return;
  w.isMaximized() ? w.unmaximize() : w.maximize();
});
ipcMain.on('window:close', (e) => BrowserWindow.fromWebContents(e.sender)?.close());
ipcMain.handle('window:isMaximized', (e) => BrowserWindow.fromWebContents(e.sender)?.isMaximized() ?? false);
ipcMain.handle('app:platform', () => process.platform);

// IPC: sessions:export
ipcMain.handle('sessions:export', async (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  const sessions = store.get('sessions', []);
  const { filePath, canceled } = await dialog.showSaveDialog(win, {
    title: '导出会话',
    defaultPath: path.join(app.getPath('desktop'), 'ssh-sessions.json'),
    filters: [{ name: 'JSON', extensions: ['json'] }],
  });
  if (canceled || !filePath) return { canceled: true };
  await fs.promises.writeFile(filePath, JSON.stringify({ sessions }, null, 2), 'utf8');
  return { filePath, count: sessions.length };
});

// IPC: sessions:import
ipcMain.handle('sessions:import', async (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  const { filePaths, canceled } = await dialog.showOpenDialog(win, {
    title: '导入会话',
    filters: [{ name: 'JSON', extensions: ['json'] }],
    properties: ['openFile'],
  });
  if (canceled || filePaths.length === 0) return { canceled: true };
  const raw = await fs.promises.readFile(filePaths[0], 'utf8');
  let imported;
  try { imported = JSON.parse(raw); } catch { return { error: '文件格式错误' }; }
  const list = Array.isArray(imported) ? imported : imported.sessions;
  if (!Array.isArray(list)) return { error: '找不到 sessions 字段' };
  // Merge: skip duplicates by host+user+port
  const existing = store.get('sessions', []);
  const key = (s) => `${s.user || ''}@${s.host}:${s.port || 22}`;
  const existingKeys = new Set(existing.map(key));
  const newSessions = list
    .filter((s) => s.host)
    .map((s) => ({ ...s, id: `imported-${Date.now()}-${Math.random().toString(36).slice(2, 7)}` }))
    .filter((s) => !existingKeys.has(key(s)));
  store.set('sessions', [...existing, ...newSessions]);
  return { sessions: newSessions, count: newSessions.length, total: list.length };
});

// IPC: settings (font size etc.)
ipcMain.handle('settings:get', (event, key) => store.get(`settings.${key}`));
ipcMain.handle('settings:set', (event, key, value) => { store.set(`settings.${key}`, value); });

// IPC: commands (quick command bar)
ipcMain.handle('commands:getAll', () => store.get('commands', []));
ipcMain.handle('commands:save', (event, cmd) => {
  const commands = store.get('commands', []);
  if (cmd.id) {
    const idx = commands.findIndex((c) => c.id === cmd.id);
    if (idx >= 0) commands[idx] = cmd;
    else commands.push(cmd);
  } else {
    cmd.id = `cmd-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    commands.push(cmd);
  }
  store.set('commands', commands);
  return cmd;
});
ipcMain.handle('commands:delete', (event, id) => {
  const commands = store.get('commands', []).filter((c) => c.id !== id);
  store.set('commands', commands);
  return true;
});
ipcMain.handle('commands:reorder', (event, commands) => {
  store.set('commands', commands);
  return true;
});

// IPC: sessions:getAll
ipcMain.handle('sessions:getAll', () => {
  return store.get('sessions', []);
});

// IPC: sessions:save
ipcMain.handle('sessions:save', (event, session) => {
  const sessions = store.get('sessions', []);
  if (session.id) {
    // Update existing
    const idx = sessions.findIndex((s) => s.id === session.id);
    if (idx >= 0) {
      sessions[idx] = session;
    } else {
      sessions.push(session);
    }
  } else {
    // New session
    session.id = `session-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    sessions.push(session);
  }
  store.set('sessions', sessions);
  return session;
});

// IPC: sessions:delete
ipcMain.handle('sessions:delete', (event, id) => {
  const sessions = store.get('sessions', []);
  const filtered = sessions.filter((s) => s.id !== id);
  store.set('sessions', filtered);
  return true;
});

// IPC: ssh-config:import
ipcMain.handle('ssh-config:import', () => {
  const configPath = path.join(os.homedir(), '.ssh', 'config');
  if (!fs.existsSync(configPath)) {
    return { error: 'No ~/.ssh/config found', sessions: [] };
  }

  try {
    const content = fs.readFileSync(configPath, 'utf8');
    const imported = parseSshConfig(content);
    return { sessions: imported };
  } catch (err) {
    return { error: err.message, sessions: [] };
  }
});

function parseSshConfig(content) {
  const sessions = [];
  const lines = content.split('\n');
  let current = null;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const hostMatch = line.match(/^Host\s+(.+)$/i);
    if (hostMatch) {
      if (current && current.host && !current.host.includes('*')) {
        sessions.push(finalizeSession(current));
      }
      current = {
        label: hostMatch[1].trim(),
        host: hostMatch[1].trim(),
        port: 22,
        user: '',
        identityFile: '',
        group: 'Imported',
      };
      continue;
    }

    if (!current) continue;

    const kv = line.match(/^(\w+)\s+(.+)$/);
    if (!kv) continue;

    const key = kv[1].toLowerCase();
    const val = kv[2].trim();

    switch (key) {
      case 'hostname':
        current.host = val;
        break;
      case 'port':
        current.port = parseInt(val, 10) || 22;
        break;
      case 'user':
        current.user = val;
        break;
      case 'identityfile':
        current.identityFile = val.replace(/^~/, os.homedir());
        break;
    }
  }

  if (current && current.host && !current.host.includes('*')) {
    sessions.push(finalizeSession(current));
  }

  return sessions;
}

function finalizeSession(s) {
  return {
    id: `imported-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    label: s.label || s.host,
    host: s.host,
    port: s.port || 22,
    user: s.user || '',
    identityFile: s.identityFile || '',
    group: s.group || 'Imported',
    extraArgs: '',
  };
}

// App lifecycle
app.whenReady().then(() => {
  createWindow();

  // macOS: re-create window if dock icon clicked
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  // Kill all PTY processes
  for (const [id, term] of terminals) {
    try {
      term.pty.kill();
    } catch (e) {}
  }
  terminals.clear();

  if (process.platform !== 'darwin') {
    app.quit();
  }
});

// Build native macOS menu
app.whenReady().then(() => {
  const template = [
    {
      label: 'SSH Manager',
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        {
          label: 'Quit SSH Manager',
          accelerator: 'CmdOrCtrl+Q',
          click: () => {
            const win = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0];
            if (win) win.close();
          },
        },
      ],
    },
    {
      label: 'File',
      submenu: [
        {
          label: 'New Tab',
          accelerator: 'CmdOrCtrl+T',
          click: (menuItem, win) => {
            if (win) win.webContents.send('menu:new-tab');
          },
        },
        {
          label: 'Close Tab',
          accelerator: 'CmdOrCtrl+W',
          click: (menuItem, win) => {
            if (win) win.webContents.send('menu:close-tab');
          },
        },
        { type: 'separator' },
        {
          label: 'Import from ~/.ssh/config',
          click: (menuItem, win) => {
            if (win) win.webContents.send('menu:import-ssh-config');
          },
        },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        { type: 'separator' },
        { role: 'front' },
      ],
    },
  ];

  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
});
