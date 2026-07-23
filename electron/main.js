const { app, BrowserWindow, ipcMain, Menu, shell, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const pty = require('node-pty');
const Store = require('electron-store');
const Zmodem = require('zmodem.js');

const isMac = process.platform === 'darwin';
const isWin = process.platform === 'win32';

// On Windows, use ImmAssociateContextEx(hwnd, NULL, IACE_CHILDREN) called
// directly from this (browser) process so the call is in-process and valid.
// ime-helper.exe was a separate process — ImmGetContext across processes
// always returns NULL, so it was a no-op. koffi in preload runs too late
// (after Chromium has already associated IME with its child HWNDs).
// The browser process owns all the HWNDs; calling from here is the only
// reliable path.
let _disableWinIME = (win) => {};
if (isWin) {
  try {
    const koffi = require('koffi');
    const user32 = koffi.load('user32.dll');
    const imm32 = koffi.load('imm32.dll');

    // Walk child windows to find Chrome_RenderWidgetHostHWND — the actual
    // input window where Chromium attaches its IME context. ImmGetContext on
    // the top-level HWND returns a dummy context; we need the render widget.
    const FindWindowEx = user32.func('void* FindWindowExA(void* hwndParent, void* hwndChildAfter, const char* lpszClass, const char* lpszWindow)');
    const GetClassNameA = user32.func('int GetClassNameA(void* hwnd, char* lpClassName, int nMaxCount)');
    const ImmGetContext = imm32.func('void* ImmGetContext(void* hwnd)');
    const ImmSetConversionStatus = imm32.func('bool ImmSetConversionStatus(void* himc, unsigned int fdwConversion, unsigned int fdwSentence)');
    const ImmSetOpenStatus = imm32.func('bool ImmSetOpenStatus(void* himc, bool fOpen)');
    const ImmReleaseContext = imm32.func('bool ImmReleaseContext(void* hwnd, void* himc)');
    const IME_CMODE_ALPHANUMERIC = 0; // English/alphanumeric mode

    // Recursively search for Chrome_RenderWidgetHostHWND under parentHwnd
    const findRenderWidget = (parentHwnd, depth = 0) => {
      if (depth > 5) return null;
      let child = FindWindowEx(parentHwnd, null, null, null);
      while (child) {
        const buf = Buffer.alloc(128);
        GetClassNameA(child, buf, 128);
        const cls = buf.toString('utf8').split('\0')[0];
        if (cls === 'Chrome_RenderWidgetHostHWND') return child;
        const found = findRenderWidget(child, depth + 1);
        if (found) return found;
        child = FindWindowEx(parentHwnd, child, null, null);
      }
      return null;
    };

    _disableWinIME = (win) => {
      if (!win || win.isDestroyed()) return;
      try {
        const hwndBuf = win.getNativeWindowHandle();
        const topHwnd = process.arch === 'x64'
          ? hwndBuf.readBigUInt64LE(0)
          : BigInt(hwndBuf.readUInt32LE(0));

        // Try the render widget first, fall back to top-level
        const renderHwnd = findRenderWidget(topHwnd);
        const targetHwnd = renderHwnd || topHwnd;

        const himc = ImmGetContext(targetHwnd);
        const msg = `[IME] renderHwnd=${renderHwnd}, ImmGetContext=${himc}`;
        console.log(msg);
        win.webContents.executeJavaScript(`console.log(${JSON.stringify(msg)})`).catch(() => {});

        if (himc) {
          const ok1 = ImmSetConversionStatus(himc, IME_CMODE_ALPHANUMERIC, 0);
          const ok2 = ImmSetOpenStatus(himc, false);
          const msg2 = `[IME] ImmSetConversionStatus=${ok1}, ImmSetOpenStatus(false)=${ok2}`;
          console.log(msg2);
          win.webContents.executeJavaScript(`console.log(${JSON.stringify(msg2)})`).catch(() => {});
          ImmReleaseContext(targetHwnd, himc);
        }
      } catch (e) {
        console.error('[IME] error:', e.message);
      }
    };
    console.log('[IME] koffi ready');
  } catch (e) {
    console.error('[IME] koffi init failed:', e.message);
  }
}

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

// True once the user has confirmed quitting — lets the close/quit sequence
// proceed without re-prompting (Dock 退出, Cmd+Q and the red button all
// funnel through the same confirmation).
let quitConfirmed = false;

// Ask for confirmation only when there are live sessions to lose.
async function confirmQuit(parentWin) {
  if (terminals.size === 0) return true;
  const opts = {
    type: 'question',
    buttons: ['关闭', '取消'],
    defaultId: 0,
    cancelId: 1,
    title: '确认关闭',
    message: '确定要关闭 SSH Manager 吗？',
    detail: `当前有 ${terminals.size} 个活动的终端会话将被断开。`,
  };
  const { response } = parentWin && !parentWin.isDestroyed()
    ? await dialog.showMessageBox(parentWin, opts)
    : await dialog.showMessageBox(opts);
  return response === 0;
}

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
    if (isDev) win.webContents.openDevTools({ mode: 'detach' });
  });

  // Disable IME on load (covers first open) and on every focus (covers
  // Alt-Tab back). Both are needed because Chromium may re-associate IME
  // with its child window after the renderer finishes loading.
  win.webContents.on('did-finish-load', () => {
    _disableWinIME(win);
    // Retry after Chromium finishes attaching its render widget HWND
    setTimeout(() => _disableWinIME(win), 500);
  });
  win.on('focus', () => {
    _disableWinIME(win);
    if (!win.isDestroyed()) win.webContents.send('window:focused');
  });

  win.on('close', async (e) => {
    if (quitConfirmed) return; // confirmed quit in progress — let the window close
    e.preventDefault();
    if (await confirmQuit(win)) {
      quitConfirmed = true;
      // Quit the whole app, not just the window — destroying only the window
      // leaves the app alive in the Dock on macOS, forcing a second 退出.
      app.quit();
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
  args.push('-o', 'ConnectTimeout=10');
  args.push('-o', 'ServerAliveInterval=3');
  args.push('-o', 'ServerAliveCountMax=2');

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

  return () => dispose.dispose();
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
        '-o', 'ConnectTimeout=10',
      ];
      if (port) spawnArgs.push('-p', port);
      spawnArgs.push(`${user}@${host}`);
    } else {
      spawnArgs = [
        '-o', 'StrictHostKeyChecking=accept-new',
        '-o', 'BatchMode=no',
        '-o', 'PasswordAuthentication=yes',
        '-o', 'PreferredAuthentications=keyboard-interactive,password,publickey',
        '-o', 'ConnectTimeout=10',
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
    const home = os.homedir();
    const userInfo = os.userInfo();
    // Packaged Electron apps on macOS/Windows can launch with a sparse process.env
    // (missing HOME, PATH, SHELL etc.), causing posix_spawnp / CreateProcess to fail.
    // Set platform-specific fallbacks first, then let real process.env override them.
    const envFallbacks = isWin ? {
      USERPROFILE: home,
      HOMEDRIVE: home.split(path.sep)[0] || 'C:',
      HOMEPATH: home.slice(home.split(path.sep)[0].length),
      USERNAME: userInfo.username,
      Path: 'C:\\Windows\\System32;C:\\Windows;C:\\Windows\\System32\\Wbem',
    } : {
      HOME: home,
      USER: userInfo.username,
      LOGNAME: userInfo.username,
      SHELL: userInfo.shell || '/bin/zsh',
      PATH: '/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin',
    };
    ptyProcess = pty.spawn(spawnCommand, spawnArgs, {
      name: 'xterm-256color',
      cols,
      rows,
      cwd: home,
      // binary encoding so Zmodem data passes through correctly
      encoding: null,
      env: {
        ...envFallbacks,
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
  // Suppress terminal output during an active ZMODEM session.
  // The UI shows its own progress overlay; letting ZMODEM binary frames / file
  // bytes pass through causes garbled output after the transfer ends.
  let zmodemActive = false;
  let zmodemRetractTimer = null;

  // Called once the sentry confirms the remote has finished (on_retract).
  // Waits a short grace period for any final status bytes from rz/sz, then
  // re-enables normal terminal display.
  const releaseZmodem = (reason) => {
    console.log(`[zmodem id=${id}] releaseZmodem called reason=${reason} zmodemActive=${zmodemActive}`);
    clearTimeout(zmodemRetractTimer);
    zmodemRetractTimer = setTimeout(() => {
      console.log(`[zmodem id=${id}] gate opened after grace period`);
      zmodemActive = false;
      try { ptyProcess.write('\r\n'); } catch (_) {}
      if (win && !win.isDestroyed()) {
        win.webContents.send('terminal:data', { id, data: Buffer.from('\r\x1b[K') });
      }
    }, 500);
  };

  const sentry = new Zmodem.Sentry({
    to_terminal: (octets) => {
      if (zmodemActive) {
        console.log(`[zmodem id=${id}] to_terminal SUPPRESSED ${octets.length} bytes`);
        return;
      }
      console.log(`[zmodem id=${id}] to_terminal PASS ${octets.length} bytes`);
      if (win && !win.isDestroyed()) {
        win.webContents.send('terminal:data', { id, data: Buffer.from(octets) });
      }
    },
    sender: (octets) => {
      try { ptyProcess.write(Buffer.from(octets)); } catch (_) {}
    },
    on_retract: () => {
      console.log(`[zmodem id=${id}] on_retract fired zmodemActive=${zmodemActive}`);
      releaseZmodem('on_retract');
      if (win && !win.isDestroyed()) {
        win.webContents.send('terminal:zmodem', { id, type: 'end' });
      }
    },
    on_detect: (detection) => {
      console.log(`[zmodem id=${id}] on_detect fired role=${detection.get_session_role()}`);
      zmodemActive = true;
      clearTimeout(zmodemRetractTimer);
      handleZmodemDetection({
        detection, id, win, ptyProcess,
        onEnd: (r) => releaseZmodem(r || 'onEnd-fallback'),
      });
    },
  });

  ptyProcess.onData((data) => {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(String(data));
    try {
      sentry.consume(Array.from(buf));
    } catch (err) {
      console.log(`[zmodem id=${id}] sentry.consume threw zmodemActive=${zmodemActive} err=${err.message} bytes=${buf.length} hex=${buf.slice(0,16).toString('hex')}`);
      if (!zmodemActive && win && !win.isDestroyed()) {
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
async function handleZmodemDetection({ detection, id, win, ptyProcess, onEnd }) {
  const role = detection.get_session_role();
  win.webContents.send('terminal:zmodem', { id, type: 'start', direction: role });

  // Called on every explicit exit path (upload done / download done / abort).
  // For normal completions, on_retract will fire and call onEnd (= releaseZmodem)
  // once the remote sends ZFIN.  finish() just notifies the UI here; the actual
  // gate release is driven by on_retract → releaseZmodem.
  // For abort/error paths where on_retract may never fire, onEnd is still called
  // so releaseZmodem runs as a fallback.
  const finish = () => {
    // onEnd === releaseZmodem — schedules the 500 ms gate release.
    // If on_retract already fired it, the clearTimeout inside prevents a double run.
    onEnd?.();
  };

  let session;
  try {
    session = detection.confirm();
  } catch (e) {
    console.error('zmodem confirm failed:', e);
    win.webContents.send('terminal:zmodem', { id, type: 'end' });
    finish();
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
          finish();
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

      session.on('session_end', () => {
        notify({ type: 'end' });
        finish();
      });

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
        finish();
        return;
      }

      for (const filePath of filePaths) {
        const fileData = await fs.promises.readFile(filePath);
        const fileName = path.basename(filePath);
        notify({ type: 'progress', name: fileName, received: 0, total: fileData.length });

        const xfer = await session.send_offer({ name: fileName, size: fileData.length, mtime: new Date() });
        if (xfer) {
          // Use 64 KB chunks and yield the event loop after each one.
          // A tight synchronous loop blocks onData() so ZRPOS/ZACK frames
          // from the remote rz can never be processed, causing rz to abort.
          const CHUNK = 65536;
          let chunksSent = 0;
          for (let offset = 0; offset < fileData.length; offset += CHUNK) {
            xfer.send(fileData.slice(offset, Math.min(offset + CHUNK, fileData.length)));
            chunksSent++;
            notify({ type: 'progress', name: fileName, received: Math.min(offset + CHUNK, fileData.length), total: fileData.length });
            await new Promise(resolve => setImmediate(resolve));
          }
          console.log(`[zmodem id=${id}] all chunks sent total=${chunksSent}, calling xfer.end([])`);
          // Timeout: 60s base + 1s per MB, so a 1.4 GB file gets ~1500s max.
          // Remote rz must flush the file to disk before sending ZRINIT back.
          const endTimeoutMs = 60000 + Math.ceil(fileData.length / (1024 * 1024)) * 1000;
          console.log(`[zmodem id=${id}] xfer.end timeout=${endTimeoutMs}ms`);
          await Promise.race([
            xfer.end([]).then(() => console.log(`[zmodem id=${id}] xfer.end([]) resolved`)),
            new Promise((_, reject) => setTimeout(() => reject(new Error(`xfer.end timeout after ${endTimeoutMs}ms`)), endTimeoutMs)),
          ]);
        }
        notify({ type: 'done', name: fileName, size: fileData.length });
      }

      session.close();
      notify({ type: 'end' });
      finish();
    }
  } catch (e) {
    console.error('zmodem transfer error:', e);
    notify({ type: 'end' });
    finish();
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

// IPC: last-open tabs (save before quit, restore on launch)
ipcMain.handle('tabs:save', (event, tabs) => { store.set('lastTabs', tabs); });
ipcMain.handle('tabs:restore', () => store.get('lastTabs', []));

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

// IPC: command history (7-day retention)
const HISTORY_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function historyPrune() {
  const cutoff = Date.now() - HISTORY_TTL_MS;
  const entries = store.get('cmdHistory', []);
  const pruned = entries.filter((e) => e.ts >= cutoff);
  if (pruned.length !== entries.length) store.set('cmdHistory', pruned);
}
historyPrune(); // prune on startup

ipcMain.handle('history:add', (event, { cmd, host }) => {
  if (!cmd || !cmd.trim()) return;
  historyPrune();
  const entries = store.get('cmdHistory', []);
  const trimmedCmd = cmd.trim();

  // Dedup: remove exact duplicates. If the new command is a prefix of an existing
  // command (and very close in length), skip saving the new command and keep the
  // more complete one. Otherwise, remove older prefixes of the new command.
  let skipSave = false;
  const deduped = entries.filter((e) => {
    if (e.cmd === trimmedCmd) return false; // exact duplicate — always remove old one
    // If existing command starts with new command AND they're close in length,
    // skip saving the new command (keep the more complete one)
    if (e.cmd.startsWith(trimmedCmd) && e.cmd.length > trimmedCmd.length &&
        e.cmd.length - trimmedCmd.length <= 10) {
      skipSave = true;
      return true; // keep the more complete existing command
    }
    // Remove if new command starts with old command (old is a prefix of new)
    if (trimmedCmd.startsWith(e.cmd) && e.cmd.length < trimmedCmd.length &&
        trimmedCmd.length - e.cmd.length <= 10) {
      return false;
    }
    return true;
  });

  if (!skipSave) {
    deduped.push({ cmd: trimmedCmd, host: host || '', ts: Date.now() });
  }
  store.set('cmdHistory', deduped);
});

ipcMain.handle('history:search', (event, { query, limit = 50 }) => {
  historyPrune();
  const entries = store.get('cmdHistory', []);
  const q = (query || '').toLowerCase();
  const matched = q
    ? entries.filter((e) => e.cmd.toLowerCase().startsWith(q)).reverse()
    : [...entries].reverse();
  return matched.slice(0, limit);
});

ipcMain.handle('history:getAll', () => {
  historyPrune();
  return [...store.get('cmdHistory', [])].reverse();
});

ipcMain.handle('history:delete', (event, cmd) => {
  const entries = store.get('cmdHistory', []).filter((e) => e.cmd !== cmd);
  store.set('cmdHistory', entries);
});

ipcMain.handle('history:clear', () => { store.set('cmdHistory', []); });

// IPC: ssh:removeHostKey — clear a stale entry from ~/.ssh/known_hosts after
// a "REMOTE HOST IDENTIFICATION HAS CHANGED" failure. ssh-keygen -R handles
// hashed known_hosts entries too, which manual sed/grep would miss.
ipcMain.handle('ssh:removeHostKey', (event, { host, port }) => {
  return new Promise((resolve) => {
    // Only allow hostname/IP characters — this string reaches a shell-out.
    if (!host || !/^[A-Za-z0-9._:\-]+$/.test(String(host))) return resolve(false);
    const target = port && Number(port) !== 22 ? `[${host}]:${port}` : String(host);
    const { execFile } = require('child_process');
    execFile('ssh-keygen', ['-R', target], (err) => resolve(!err));
  });
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

  // macOS: when the app window gains focus, switch to the first ASCII-capable
  // keyboard input source (e.g. ABC / US English) using a bundled Swift helper
  // that calls TISSelectInputSource directly — no Accessibility permission needed.
  if (isMac) {
    const { execFile } = require('child_process');
    const switchImePath = app.isPackaged
      ? path.join(process.resourcesPath, 'switch-ime')
      : path.join(__dirname, '..', 'assets', 'switch-ime');
    app.on('browser-window-focus', () => {
      execFile(switchImePath, { timeout: 800 }, () => {});
    });
  }

  // macOS: re-create window if dock icon clicked
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

// Dock 退出 / Cmd+Q enter here first; confirm once, then quit for real.
app.on('before-quit', async (e) => {
  if (quitConfirmed) return;
  e.preventDefault();
  const win = BrowserWindow.getAllWindows()[0];
  if (await confirmQuit(win)) {
    quitConfirmed = true;
    app.quit();
  }
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
