import React, { useState, useEffect, useCallback, useRef } from 'react';
import Sidebar from './components/Sidebar.jsx';
import HistoryPanel from './components/HistoryPanel.jsx';
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
  const [activityTabs, setActivityTabs] = useState(new Set());
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingSession, setEditingSession] = useState(null);
  const [sidebarWidth, setSidebarWidth] = useState(240);
  const [sidebarTab, setSidebarTab] = useState('sessions'); // 'sessions' or 'history'
  const isResizing = useRef(false);
  const resizeStartX = useRef(0);
  const resizeStartWidth = useRef(0);
  // Map of tabId -> sendCommand function registered by each TerminalPane
  const terminalSendRefs = useRef({});
  // Guard: don't overwrite stored tabs with [] before restore completes
  const hasRestoredRef = useRef(false);
  // Mirror of activeTabId kept in a ref so it can be read inside setTabs updaters
  // without stale closures (the ref is updated on every render, before effects run).
  const activeTabIdRef = useRef(null);

  // Keep ref in sync with state on every render (no deps = always current)
  activeTabIdRef.current = activeTabId;

  // Guardian: ensure activeTabId always points to an existing tab.
  useEffect(() => {
    if (tabs.length === 0) {
      if (activeTabId !== null) setActiveTabId(null);
      return;
    }
    if (!tabs.find((t) => t.id === activeTabId)) {
      setActiveTabId(tabs[tabs.length - 1].id);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabs]);

  // Load sessions + restore last open tabs on mount
  useEffect(() => {
    if (!window.electronAPI) return;
    window.electronAPI.sessions.getAll().then(setSessions);
    window.electronAPI.tabs.restore().then((savedTabs) => {
      hasRestoredRef.current = true;
      if (!savedTabs || savedTabs.length === 0) return;
      const restored = savedTabs.map((t) => createTab({
        title: t.title,
        sessionConfig: t.sessionConfig || null,
        quickConnect: t.quickConnect || null,
        password: t.password || null,
      }));
      setTabs(restored);
      setActiveTabId(restored[0].id);
    });
  }, []);

  // Persist open tabs on every change so the store is always up-to-date.
  // win.destroy() in the main process bypasses beforeunload, so we cannot
  // rely on a final save-on-close — real-time sync is the only reliable approach.
  useEffect(() => {
    if (!window.electronAPI) return;
    // Skip the initial render before restore has finished loading saved tabs
    if (!hasRestoredRef.current) return;
    const snapshot = tabs.map((t) => ({
      title: t.title,
      sessionConfig: t.sessionConfig || null,
      quickConnect: t.quickConnect || null,
      // never persist plaintext passwords
      password: null,
    }));
    window.electronAPI.tabs.save(snapshot);
  }, [tabs]);

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
      if (idx === -1) return prev;
      const next = prev.filter((t) => t.id !== tabId);
      if (tabId === activeTabIdRef.current) {
        setActiveTabId(next.length > 0 ? next[Math.min(idx, next.length - 1)].id : null);
      }
      return next;
    });
  }, []);

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
    setTabs((prev) => {
      const idx = prev.findIndex((t) => t.id === tab.id);
      const next = [...prev];
      next.splice(idx === -1 ? next.length : idx + 1, 0, newTab);
      return next;
    });
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

  const handleSelectTab = useCallback((tabId) => {
    setActiveTabId(tabId);
    setActivityTabs((prev) => {
      if (!prev.has(tabId)) return prev;
      const next = new Set(prev);
      next.delete(tabId);
      return next;
    });
  }, []);

  const handleActivity = useCallback((tabId) => {
    setActivityTabs((prev) => {
      if (prev.has(tabId)) return prev;
      const next = new Set(prev);
      next.add(tabId);
      return next;
    });
  }, []);

  const activeTab = tabs.find((t) => t.id === activeTabId);

  return (
    <div className={`app platform-${window.electronAPI?.platform || 'darwin'}`}>
      <div className="app-body">
        {/* Main content */}
        <div className="main-content">
          <TabBar
            tabs={tabs}
            activeTabId={activeTabId}
            activityTabs={activityTabs}
            onSelect={handleSelectTab}
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
                              onActivity={() => handleActivity(tab.id)}
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
        <div style={{ width: sidebarWidth, display: 'flex', flexDirection: 'column', overflow: 'hidden', flexShrink: 0 }}>
          {/* Sidebar tabs */}
          <div style={{ display: 'flex', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
            <button
              onClick={() => setSidebarTab('sessions')}
              style={{
                flex: 1, padding: '8px', border: 'none', background: sidebarTab === 'sessions' ? 'var(--bg-secondary)' : 'transparent',
                borderBottom: sidebarTab === 'sessions' ? '2px solid var(--text-primary)' : 'none',
                color: sidebarTab === 'sessions' ? 'var(--text-primary)' : 'var(--text-muted)',
                cursor: 'pointer', fontSize: 12, fontWeight: 500,
              }}
            >
              会话
            </button>
            <button
              onClick={() => setSidebarTab('history')}
              style={{
                flex: 1, padding: '8px', border: 'none', background: sidebarTab === 'history' ? 'var(--bg-secondary)' : 'transparent',
                borderBottom: sidebarTab === 'history' ? '2px solid var(--text-primary)' : 'none',
                color: sidebarTab === 'history' ? 'var(--text-primary)' : 'var(--text-muted)',
                cursor: 'pointer', fontSize: 12, fontWeight: 500,
              }}
            >
              历史
            </button>
          </div>
          {/* Sidebar content */}
          <div style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
            {sidebarTab === 'sessions' ? (
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
            ) : (
              <HistoryPanel
                onUse={(cmd) => {
                  if (activeTabId) {
                    const sendFn = terminalSendRefs.current[activeTabId];
                    if (sendFn) sendFn(cmd);
                  }
                }}
                onClose={() => {}} // No-op since we're always showing history in the tab
              />
            )}
          </div>
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
