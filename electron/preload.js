const { contextBridge, ipcRenderer, clipboard } = require('electron');

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
