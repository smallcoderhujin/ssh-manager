const { contextBridge, ipcRenderer, clipboard } = require('electron');
const os = require('os');

// On Windows, switch the focused window's IME to English (alphanumeric) mode
// by calling IMM32 from within the renderer process (same process as Chromium,
// so ImmGetContext returns a valid HIMC unlike calls from the main process).
if (os.platform() === 'win32') {
  try {
    const koffi = require('koffi');
    const user32 = koffi.load('user32.dll');
    const imm32 = koffi.load('imm32.dll');
    const GetFocus = user32.func('void* GetFocus()');
    const ImmGetContext = imm32.func('void* ImmGetContext(void* hwnd)');
    const ImmSetConversionStatus = imm32.func('bool ImmSetConversionStatus(void* himc, unsigned int fdwConversion, unsigned int fdwSentence)');
    const ImmReleaseContext = imm32.func('bool ImmReleaseContext(void* hwnd, void* himc)');
    const IME_CMODE_ALPHANUMERIC = 0; // English mode

    const ImmSetOpenStatus = imm32.func('bool ImmSetOpenStatus(void* himc, bool fOpen)');

    const switchImeToEnglish = () => {
      try {
        const hwnd = GetFocus();
        if (!hwnd) return;
        const himc = ImmGetContext(hwnd);
        if (!himc) return;
        ImmSetOpenStatus(himc, false);
        ImmSetConversionStatus(himc, IME_CMODE_ALPHANUMERIC, 0);
        ImmReleaseContext(hwnd, himc);
      } catch (e) {
        console.error('[IME-preload] error:', e.message);
      }
    };

    // Run immediately and on every focus/load event
    window.addEventListener('DOMContentLoaded', switchImeToEnglish);
    window.addEventListener('focus', switchImeToEnglish);
    ipcRenderer.on('window:focused', switchImeToEnglish);
    console.log('[IME-preload] initialized');
  } catch (e) {
    console.error('[IME-preload] init failed:', e.message);
  }
}

contextBridge.exposeInMainWorld('electronAPI', {
  // Terminal API
  terminal: {
    create: (options) => ipcRenderer.invoke('terminal:create', options),
    write: (id, data) => ipcRenderer.send('terminal:write', { id, data }),
    resize: (id, cols, rows) => ipcRenderer.send('terminal:resize', { id, cols, rows }),
    kill: (id) => ipcRenderer.send('terminal:kill', { id }),
    onData: (callback) => {
      const handler = (event, payload) => callback(payload);
      ipcRenderer.on('terminal:data', handler);
      return () => ipcRenderer.removeListener('terminal:data', handler);
    },
    onExit: (callback) => {
      const handler = (event, payload) => callback(payload);
      ipcRenderer.on('terminal:exit', handler);
      return () => ipcRenderer.removeListener('terminal:exit', handler);
    },
    onZmodem: (callback) => {
      const handler = (event, payload) => callback(payload);
      ipcRenderer.on('terminal:zmodem', handler);
      return () => ipcRenderer.removeListener('terminal:zmodem', handler);
    },
  },

  shell: {
    showItemInFolder: (filePath) => ipcRenderer.invoke('shell:showItemInFolder', filePath),
  },

  // Sessions API
  sessions: {
    getAll: () => ipcRenderer.invoke('sessions:getAll'),
    save: (session) => ipcRenderer.invoke('sessions:save', session),
    delete: (id) => ipcRenderer.invoke('sessions:delete', id),
    export: () => ipcRenderer.invoke('sessions:export'),
    import: () => ipcRenderer.invoke('sessions:import'),
  },

  // SSH Config import
  sshConfig: {
    import: () => ipcRenderer.invoke('ssh-config:import'),
  },

  // Settings
  settings: {
    get: (key) => ipcRenderer.invoke('settings:get', key),
    set: (key, value) => ipcRenderer.invoke('settings:set', key, value),
  },

  // Last-open tabs persistence
  tabs: {
    save: (tabs) => ipcRenderer.invoke('tabs:save', tabs),
    restore: () => ipcRenderer.invoke('tabs:restore'),
  },

  // Clipboard (bypass navigator.clipboard restrictions)
  clipboard: {
    writeText: (text) => clipboard.writeText(text),
    readText: () => clipboard.readText(),
  },

  // Platform
  platform: process.platform,

  // Window controls (Windows/Linux)
  window: {
    minimize: () => ipcRenderer.send('window:minimize'),
    maximize: () => ipcRenderer.send('window:maximize'),
    close: () => ipcRenderer.send('window:close'),
    isMaximized: () => ipcRenderer.invoke('window:isMaximized'),
  },

  // Commands (quick command bar)
  commands: {
    getAll: () => ipcRenderer.invoke('commands:getAll'),
    save: (cmd) => ipcRenderer.invoke('commands:save', cmd),
    delete: (id) => ipcRenderer.invoke('commands:delete', id),
    reorder: (commands) => ipcRenderer.invoke('commands:reorder', commands),
  },

  // Show native popup menu
  showPopupMenu: () => ipcRenderer.send('menu:show-popup'),

  // Menu events
  onMenuEvent: (callback) => {
    const events = [
      'menu:new-tab', 'menu:close-tab', 'menu:import-ssh-config',
      'menu:add-session', 'menu:import-sessions', 'menu:export-sessions',
    ];
    const handlers = events.map((event) => {
      const handler = () => callback(event);
      ipcRenderer.on(event, handler);
      return { event, handler };
    });
    return () => {
      handlers.forEach(({ event, handler }) => {
        ipcRenderer.removeListener(event, handler);
      });
    };
  },
});
