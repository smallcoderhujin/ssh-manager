import React, { useState, useEffect, useCallback, useRef } from 'react';
import Sidebar from './components/Sidebar.jsx';
import TabBar from './components/TabBar.jsx';
import TerminalPane from './components/TerminalPane.jsx';
import SessionDialog from './components/SessionDialog.jsx';
import CommandBar from './components/CommandBar.jsx';

let tabIdCounter = 0;

function createTab(options = {}) {
  return {
    id: ++tabIdCounter,
    title: options.title || 'New Tab',
    sessionConfig: options.sessionConfig || null,
    quickConnect: options.quickConnect || null,
    password: options.password || null,
    status: 'connecting',
    splits: [{ id: `split-${tabIdCounter}-1` }],
    splitDirection: 'horizontal', // 'horizontal' = 左右, 'vertical' = 上下
  };
}

export default function App() {
  const [sessions, setSessions] = useState([]);
  const [tabs, setTabs] = useState([]);
  const [activeTabId, setActiveTabId] = useState(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingSession, setEditingSession] = useState(null);
  const [sidebarWidth, setSidebarWidth] = useState(240);
  const isResizing = useRef(false);
  const resizeStartX = useRef(0);
  const resizeStartWidth = useRef(0);
  // Map of tabId -> sendCommand function registered by each TerminalPane
  const terminalSendRefs = useRef({});

  // Load sessions on mount
  useEffect(() => {
    if (window.electronAPI) {
      window.electronAPI.sessions.getAll().then(setSessions);
    }
  }, []);

  // Listen for menu events
  useEffect(() => {
    if (!window.electronAPI) return;
    const cleanup = window.electronAPI.onMenuEvent((event) => {
      if (event === 'menu:new-tab') handleNewTab();
      else if (event === 'menu:close-tab') handleCloseTab(activeTabId);
      else if (event === 'menu:import-ssh-config') handleImportSshConfig();
      else if (event === 'menu:add-session') handleAddSession();
      else if (event === 'menu:import-sessions') handleImportSessions();
      else if (event === 'menu:export-sessions') handleExportSessions();
    });
    return cleanup;
  }, [activeTabId]);

  // Keyboard shortcuts
  useEffect(() => {
    const handler = (e) => {
      const meta = e.metaKey || e.ctrlKey;
      if (!meta) return;

      if (e.key === 't') {
        e.preventDefault();
        handleNewTab();
      } else if (e.key === 'w') {
        e.preventDefault();
        handleCloseTab(activeTabId);
      } else if (e.key >= '1' && e.key <= '9') {
        const idx = parseInt(e.key, 10) - 1;
        if (tabs[idx]) {
          e.preventDefault();
          setActiveTabId(tabs[idx].id);
        }
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [tabs, activeTabId]);

  const handleNewTab = useCallback((options = {}) => {
    const tab = createTab(options);
    setTabs((prev) => [...prev, tab]);
    setActiveTabId(tab.id);
    return tab;
  }, []);

  const handleCloseTab = useCallback((tabId) => {
    if (!tabId) return;
    setTabs((prev) => {
      const idx = prev.findIndex((t) => t.id === tabId);
      const next = prev.filter((t) => t.id !== tabId);
      if (next.length > 0 && tabId === activeTabId) {
        const newActive = next[Math.min(idx, next.length - 1)];
        setActiveTabId(newActive.id);
      } else if (next.length === 0) {
        setActiveTabId(null);
      }
      return next;
    });
  }, [activeTabId]);

  const handleDuplicateSession = useCallback(async (session) => {
    if (!window.electronAPI) return;
    const copy = { ...session, id: null, label: `${session.label || session.host} copy` };
    const saved = await window.electronAPI.sessions.save(copy);
    setSessions((prev) => [...prev, saved]);
  }, []);

  const handleConnectSession = useCallback((session) => {
    const tab = createTab({
      title: session.label || `${session.user || ''}@${session.host}`,
      sessionConfig: session,
    });
    setTabs((prev) => [...prev, tab]);
    setActiveTabId(tab.id);
  }, []);


  const handleDuplicateTab = useCallback((tab) => {
    const newTab = createTab({
      title: tab.title,
      sessionConfig: tab.sessionConfig,
      quickConnect: tab.quickConnect,
      password: tab.password,
    });
    setTabs((prev) => [...prev, newTab]);
    setActiveTabId(newTab.id);
  }, []);

  const handleTabStatusChange = useCallback((tabId, status) => {
    setTabs((prev) =>
      prev.map((t) => (t.id === tabId ? { ...t, status } : t))
    );
  }, []);

  const handleSplitTab = useCallback((tabId, direction = 'horizontal') => {
    setTabs((prev) =>
      prev.map((t) => {
        if (t.id !== tabId) return t;
        const newSplitId = `split-${t.id}-${t.splits.length + 1}`;
        return { ...t, splits: [...t.splits, { id: newSplitId }], splitDirection: direction };
      })
    );
  }, []);

  const handleCloseSplit = useCallback((tabId, splitId) => {
    setTabs((prev) =>
      prev.map((t) => {
        if (t.id !== tabId) return t;
        const splits = t.splits.filter((s) => s.id !== splitId);
        return { ...t, splits: splits.length > 0 ? splits : t.splits };
      })
    );
  }, []);

  const handleSaveSession = useCallback(async (session) => {
    if (!window.electronAPI) return;
    const saved = await window.electronAPI.sessions.save(session);
    setSessions((prev) => {
      const idx = prev.findIndex((s) => s.id === saved.id);
      if (idx >= 0) {
        const next = [...prev];
        next[idx] = saved;
        return next;
      }
      return [...prev, saved];
    });
    setDialogOpen(false);
    setEditingSession(null);
  }, []);

  const handleDeleteSession = useCallback(async (id) => {
    if (!window.electronAPI) return;
    await window.electronAPI.sessions.delete(id);
    setSessions((prev) => prev.filter((s) => s.id !== id));
  }, []);

  const handleEditSession = useCallback((session) => {
    setEditingSession(session);
    setDialogOpen(true);
  }, []);

  const handleAddSession = useCallback(() => {
    setEditingSession(null);
    setDialogOpen(true);
  }, []);

  const handleExportSessions = useCallback(async () => {
    if (!window.electronAPI) return;
    const result = await window.electronAPI.sessions.export();
    if (!result.canceled && !result.error) {
      alert(`已导出 ${result.count} 个会话到:\n${result.filePath}`);
    }
  }, []);

  const handleImportSessions = useCallback(async () => {
    if (!window.electronAPI) return;
    const result = await window.electronAPI.sessions.import();
    if (result.error) { alert(`导入失败: ${result.error}`); return; }
    if (result.canceled) return;
    const all = await window.electronAPI.sessions.getAll();
    setSessions(all);
    alert(`成功导入 ${result.count} 个会话（跳过 ${result.total - result.count} 个重复）`);
  }, []);

  const handleImportSshConfig = useCallback(async () => {
    if (!window.electronAPI) return;
    const result = await window.electronAPI.sshConfig.import();
    if (result.error && result.sessions.length === 0) {
      alert(result.error);
      return;
    }
    // Save all imported sessions
    const savedAll = await Promise.all(
      result.sessions.map((s) => window.electronAPI.sessions.save(s))
    );
    setSessions((prev) => {
      const existingIds = new Set(prev.map((s) => s.id));
      const newOnes = savedAll.filter((s) => !existingIds.has(s.id));
      return [...prev, ...newOnes];
    });
    alert(`Imported ${savedAll.length} session(s) from ~/.ssh/config`);
  }, []);

  // Sidebar resize
  const startSidebarResize = useCallback((e) => {
    isResizing.current = true;
    resizeStartX.current = e.clientX;
    resizeStartWidth.current = sidebarWidth;
    e.preventDefault();
  }, [sidebarWidth]);

  useEffect(() => {
    const onMouseMove = (e) => {
      if (!isResizing.current) return;
      // Sidebar is on the right: dragging left increases width
      const delta = resizeStartX.current - e.clientX;
      const newWidth = Math.max(160, Math.min(400, resizeStartWidth.current + delta));
      setSidebarWidth(newWidth);
    };
    const onMouseUp = () => { isResizing.current = false; };
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
    return () => {
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    };
  }, []);

  // Called by CommandBar to send a command to the active terminal
  const handleSendCommand = useCallback((text) => {
    if (!activeTabId) return;
    const fn = terminalSendRefs.current[activeTabId];
    if (fn) fn(text);
  }, [activeTabId]);

  const activeTab = tabs.find((t) => t.id === activeTabId);

  return (
    <div className={`app platform-${window.electronAPI?.platform || 'darwin'}`}>
      <div className="app-body">
        {/* Main content */}
        <div className="main-content">
          <TabBar
            tabs={tabs}
            activeTabId={activeTabId}
            onSelect={setActiveTabId}
            onClose={handleCloseTab}
            onNew={handleNewTab}
            onDuplicate={handleDuplicateTab}
            onReorder={setTabs}
            onAddSession={handleAddSession}
            onImportSshConfig={handleImportSshConfig}
            onImportSessions={handleImportSessions}
            onExportSessions={handleExportSessions}
          />

          {/* Terminal area */}
          <div className="terminal-area" style={{ display: 'flex', flexDirection: 'column' }}>
            <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
              {tabs.length === 0 ? (
                <EmptyState onNewTab={handleNewTab} onAddSession={handleAddSession} />
              ) : (
                tabs.map((tab) => (
                  <div
                    key={tab.id}
                    className="terminal-container"
                    style={{ display: tab.id === activeTabId ? 'flex' : 'none', flex: 1 }}
                  >
                    <div className="terminal-toolbar">
                      <span className="terminal-toolbar-title">
                        {tab.title}
                      </span>
                      {tab.splits.length === 1 ? (
                        <>
                          <button
                            className="terminal-toolbar-btn"
                            title="左右分屏"
                            onClick={() => handleSplitTab(tab.id, 'horizontal')}
                          >
                            ⬜ 左右
                          </button>
                          <button
                            className="terminal-toolbar-btn"
                            title="上下分屏"
                            onClick={() => handleSplitTab(tab.id, 'vertical')}
                          >
                            ⬛ 上下
                          </button>
                        </>
                      ) : (
                        <span style={{ fontSize: 10, color: 'var(--text-muted)', marginLeft: 4 }}>
                          {tab.splitDirection === 'vertical' ? '上下分屏' : '左右分屏'}
                        </span>
                      )}
                    </div>
                    <div className={`terminal-split terminal-split--${tab.splitDirection || 'horizontal'}`}>
                      {tab.splits.map((split, idx) => (
                        <React.Fragment key={split.id}>
                          {idx > 0 && <div className={`split-handle split-handle--${tab.splitDirection || 'horizontal'}`} />}
                          <div className="terminal-pane-wrapper">
                            <TerminalPane
                              splitId={split.id}
                              tabId={tab.id}
                              sessionConfig={tab.sessionConfig}
                              quickConnect={tab.quickConnect}
                              password={tab.password}
                              isActive={tab.id === activeTabId}
                              onStatusChange={(status) => handleTabStatusChange(tab.id, status)}
                              onClose={tab.splits.length > 1 ? () => handleCloseSplit(tab.id, split.id) : null}
                              onReady={(sendFn) => { terminalSendRefs.current[tab.id] = sendFn; }}
                            />
                          </div>
                        </React.Fragment>
                      ))}
                    </div>
                  </div>
                ))
              )}
            </div>
            {/* Command bar at bottom */}
            <CommandBar onSendCommand={handleSendCommand} />
          </div>
        </div>

        {/* Right sidebar resize handle */}
        <div
          className="sidebar-resizer"
          onMouseDown={startSidebarResize}
        />

        {/* Right sidebar */}
        <div style={{ width: sidebarWidth, display: 'flex', overflow: 'hidden', flexShrink: 0 }}>
          <Sidebar
            sessions={sessions}
            onConnect={handleConnectSession}
            onAdd={handleAddSession}
            onEdit={handleEditSession}
            onDelete={handleDeleteSession}
            onDuplicate={handleDuplicateSession}
            onImport={handleImportSshConfig}
            onExportSessions={handleExportSessions}
            onImportSessions={handleImportSessions}
          />
        </div>
      </div>

      {/* Session dialog */}
      {dialogOpen && (
        <SessionDialog
          session={editingSession}
          onSave={handleSaveSession}
          onClose={() => { setDialogOpen(false); setEditingSession(null); }}
          existingGroups={[...new Set(sessions.map((s) => s.group || 'Default').filter(Boolean))].sort()}
        />
      )}
    </div>
  );
}

function WinControls() {
  const api = window.electronAPI?.window;
  if (!api) return null;
  return (
    <div className="win-controls" style={{ marginLeft: 'auto', display: 'flex', WebkitAppRegion: 'no-drag' }}>
      <button className="win-btn" onClick={() => api.minimize()} title="最小化">─</button>
      <button className="win-btn" onClick={() => api.maximize()} title="最大化/还原">□</button>
      <button className="win-btn close" onClick={() => api.close()} title="关闭">✕</button>
    </div>
  );
}

function EmptyState({ onNewTab, onAddSession }) {
  return (
    <div className="empty-state">
      <div className="empty-state-icon">⌨️</div>
      <div className="empty-state-title">SSH Manager</div>
      <div className="empty-state-text">
        Connect to a server by selecting a saved session from the sidebar,
        using Quick Connect above, or creating a new tab.
      </div>
      <div className="empty-state-actions">
        <button className="btn primary" onClick={() => onNewTab()}>
          New Terminal Tab
        </button>
        <button className="btn" onClick={onAddSession}>
          Add Session
        </button>
      </div>
      <div style={{ display: 'flex', gap: 12, marginTop: 8 }}>
        <span className="kbd">⌘T</span>
        <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>New tab</span>
        <span className="kbd">⌘W</span>
        <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>Close tab</span>
        <span className="kbd">⌘1-9</span>
        <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>Switch tabs</span>
      </div>
    </div>
  );
}
