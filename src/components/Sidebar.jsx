import React, { useState, useMemo } from 'react';

export default function Sidebar({ sessions, onConnect, onAdd, onEdit, onDelete, onDuplicate, onImport, onExportSessions, onImportSessions }) {
  const [search, setSearch] = useState('');
  const [collapsedGroups, setCollapsedGroups] = useState(new Set());

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return sessions;
    return sessions.filter((s) => {
      return (
        s.label?.toLowerCase().includes(q) ||
        s.host?.toLowerCase().includes(q) ||
        s.user?.toLowerCase().includes(q) ||
        s.group?.toLowerCase().includes(q)
      );
    });
  }, [sessions, search]);

  const grouped = useMemo(() => {
    const map = new Map();
    for (const s of filtered) {
      const g = s.group?.trim() || 'Default';
      if (!map.has(g)) map.set(g, []);
      map.get(g).push(s);
    }
    // Sort: Default first, then alphabetically
    const sorted = new Map(
      [...map.entries()].sort(([a], [b]) => {
        if (a === 'Default') return -1;
        if (b === 'Default') return 1;
        return a.localeCompare(b);
      })
    );
    return sorted;
  }, [filtered]);

  const toggleGroup = (group) => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(group)) next.delete(group);
      else next.add(group);
      return next;
    });
  };

  const handleDelete = (e, session) => {
    e.stopPropagation();
    if (window.confirm(`Delete session "${session.label || session.host}"?`)) {
      onDelete(session.id);
    }
  };

  const handleEdit = (e, session) => {
    e.stopPropagation();
    onEdit(session);
  };

  const handleDuplicate = (e, session) => {
    e.stopPropagation();
    onDuplicate(session);
  };

  return (
    <div className="sidebar" style={{ width: '100%' }}>
      <div className="sidebar-header">
        <input
          className="sidebar-search"
          type="text"
          placeholder="Search sessions…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <button
          className="sidebar-btn accent"
          onClick={onAdd}
          title="Add new session"
          data-tooltip="Add session"
        >
          +
        </button>
      </div>


      <div className="session-list">
        {sessions.length === 0 && (
          <div style={{ padding: '20px 16px', color: 'var(--text-muted)', fontSize: 12, textAlign: 'center', lineHeight: 1.6 }}>
            No saved sessions.{'\n'}
            <span
              style={{ color: 'var(--text-accent)', cursor: 'pointer' }}
              onClick={onAdd}
            >
              Add one
            </span>{' '}
            or{' '}
            <span
              style={{ color: 'var(--text-accent)', cursor: 'pointer' }}
              onClick={onImport}
            >
              import from SSH config
            </span>
            .
          </div>
        )}

        {filtered.length === 0 && sessions.length > 0 && (
          <div style={{ padding: '20px 16px', color: 'var(--text-muted)', fontSize: 12, textAlign: 'center' }}>
            No sessions match "{search}"
          </div>
        )}

        {[...grouped.entries()].map(([group, items]) => (
          <div key={group} className="session-group">
            <div className="session-group-header" onClick={() => toggleGroup(group)}>
              <span
                className={`session-group-toggle ${collapsedGroups.has(group) ? 'collapsed' : ''}`}
              >
                ▾
              </span>
              {group}
              <span style={{ marginLeft: 'auto', fontSize: 10, color: 'var(--text-muted)' }}>
                {items.length}
              </span>
            </div>

            {!collapsedGroups.has(group) &&
              items.map((session) => (
                <SessionItem
                  key={session.id}
                  session={session}
                  onConnect={() => onConnect(session)}
                  onEdit={(e) => handleEdit(e, session)}
                  onDelete={(e) => handleDelete(e, session)}
                  onDuplicate={(e) => handleDuplicate(e, session)}
                />
              ))}
          </div>
        ))}
      </div>
    </div>
  );
}

function SessionItem({ session, onConnect, onEdit, onDelete, onDuplicate }) {
  const host = session.user ? `${session.user}@${session.host}` : session.host;
  const portStr = session.port && session.port !== 22 ? `:${session.port}` : '';

  return (
    <div className="session-item" onDoubleClick={onConnect} title={`Double-click to connect\n${host}${portStr}`}>
      <div className="session-item-icon">⚡</div>
      <div className="session-item-info">
        <div className="session-item-label">{session.label || session.host}</div>
        <div className="session-item-host">
          {host}{portStr}
        </div>
      </div>
      <div className="session-item-actions">
        <button className="session-item-action" onClick={onConnect} title="连接">▶</button>
        <button className="session-item-action" onClick={onDuplicate} title="复制会话">⎘</button>
        <button className="session-item-action" onClick={onEdit} title="编辑">✎</button>
        <button className="session-item-action danger" onClick={onDelete} title="删除">✕</button>
      </div>
    </div>
  );
}
