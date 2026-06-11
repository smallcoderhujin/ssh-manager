import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';

// ── Command Dialog (Add / Edit) ──────────────────────────────────────────────
function CommandDialog({ cmd, groups, onSave, onClose }) {
  const [form, setForm] = useState({
    label: '',
    command: '',
    group: groups[0] || 'Default',
    color: '',
  });

  useEffect(() => {
    if (cmd) setForm({ label: cmd.label || '', command: cmd.command || '', group: cmd.group || 'Default', color: cmd.color || '' });
    else setForm({ label: '', command: '', group: groups[0] || 'Default', color: '' });
  }, [cmd]);

  const set = (field) => (e) => setForm((p) => ({ ...p, [field]: e.target.value }));

  const handleSubmit = (e) => {
    e.preventDefault();
    if (!form.command.trim()) return;
    const data = { ...form, label: form.label.trim() || form.command.trim().slice(0, 20) };
    if (cmd?.id) data.id = cmd.id;
    onSave(data);
  };

  return (
    <div className="modal-overlay">
      <div className="modal" style={{ width: 420 }} role="dialog">
        <div className="modal-title">
          {cmd ? '编辑命令' : '新建命令'}
          <button type="button" onClick={onClose}
            style={{ marginLeft: 'auto', background: 'none', border: 'none', color: 'var(--text-muted)', fontSize: 18, cursor: 'pointer', padding: '0 2px' }}>
            ✕
          </button>
        </div>
        <form onSubmit={handleSubmit} autoComplete="off">
          <div className="form-group">
            <label className="form-label">命令内容 <span style={{ color: 'var(--danger)' }}>*</span></label>
            <input className="form-input mono" type="text" placeholder="例: ls -la / top / sudo systemctl restart nginx"
              value={form.command} onChange={set('command')} autoFocus />
          </div>
          <div className="form-group">
            <label className="form-label">显示名称
              <span style={{ fontSize: 10, fontWeight: 400, color: 'var(--text-muted)', marginLeft: 8, textTransform: 'none' }}>留空则截取命令前20字符</span>
            </label>
            <input className="form-input" type="text" placeholder="可选" value={form.label} onChange={set('label')} />
          </div>
          <div className="form-row">
            <div className="form-group" style={{ flex: 2 }}>
              <label className="form-label">分组</label>
              <input className="form-input" type="text" placeholder="Default"
                value={form.group} onChange={set('group')} list="cmd-group-list" />
              <datalist id="cmd-group-list">
                {groups.map((g) => <option key={g} value={g} />)}
              </datalist>
            </div>
            <div className="form-group" style={{ flex: 1 }}>
              <label className="form-label">颜色标签</label>
              <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginTop: 4 }}>
                {['', '#4e9de0', '#56b48a', '#e0944e', '#c96dce', '#e05555'].map((c) => (
                  <button key={c} type="button" onClick={() => setForm((p) => ({ ...p, color: c }))}
                    style={{
                      width: 20, height: 20, borderRadius: 10, border: form.color === c ? '2px solid #fff' : '2px solid transparent',
                      background: c || 'var(--bg-tertiary)', cursor: 'pointer', flexShrink: 0, padding: 0,
                      outline: form.color === c ? '1px solid var(--text-accent)' : 'none',
                    }} title={c || '默认'} />
                ))}
              </div>
            </div>
          </div>
          <div className="modal-footer">
            <button type="button" className="btn" onClick={onClose}>取消</button>
            <button type="submit" className="btn primary">{cmd ? '保存' : '添加'}</button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ── Context Menu ─────────────────────────────────────────────────────────────
function ContextMenu({ x, y, cmd, onEdit, onDelete, onClose }) {
  const ref = useRef(null);

  useEffect(() => {
    const handler = (e) => {
      if (ref.current && !ref.current.contains(e.target)) onClose();
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  return (
    <div ref={ref} className="cmd-context-menu" style={{ left: x, top: y }}>
      <div className="cmd-context-item" onClick={() => { onEdit(cmd); onClose(); }}>✎ 编辑</div>
      <div className="cmd-context-item danger" onClick={() => { onDelete(cmd.id); onClose(); }}>✕ 删除</div>
    </div>
  );
}

// ── Main CommandBar ───────────────────────────────────────────────────────────
export default function CommandBar({ onSendCommand }) {
  const [commands, setCommands] = useState([]);
  const [activeGroup, setActiveGroup] = useState(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingCmd, setEditingCmd] = useState(null);
  const [contextMenu, setContextMenu] = useState(null); // { x, y, cmd }

  // Load commands on mount
  useEffect(() => {
    if (!window.electronAPI) return;
    window.electronAPI.commands.getAll().then((cmds) => {
      setCommands(cmds || []);
    });
  }, []);

  // All unique groups
  const groups = useMemo(() => {
    const gs = [...new Set(commands.map((c) => c.group?.trim() || 'Default'))].sort((a, b) => {
      if (a === 'Default') return -1;
      if (b === 'Default') return 1;
      return a.localeCompare(b);
    });
    return gs;
  }, [commands]);

  // Auto-select first group
  useEffect(() => {
    if (groups.length > 0 && (activeGroup === null || !groups.includes(activeGroup))) {
      setActiveGroup(groups[0]);
    }
  }, [groups]);

  const currentGroup = activeGroup || groups[0] || 'Default';
  const visibleCmds = useMemo(
    () => commands.filter((c) => (c.group?.trim() || 'Default') === currentGroup),
    [commands, currentGroup]
  );

  const handleSave = useCallback(async (data) => {
    if (!window.electronAPI) return;
    const saved = await window.electronAPI.commands.save(data);
    setCommands((prev) => {
      if (data.id) return prev.map((c) => (c.id === data.id ? saved : c));
      return [...prev, saved];
    });
    setDialogOpen(false);
    setEditingCmd(null);
    // Switch to the saved command's group
    setActiveGroup(saved.group?.trim() || 'Default');
  }, []);

  const handleDelete = useCallback(async (id) => {
    if (!window.electronAPI) return;
    await window.electronAPI.commands.delete(id);
    setCommands((prev) => prev.filter((c) => c.id !== id));
  }, []);

  const handleClick = useCallback((cmd) => {
    if (!onSendCommand) return;
    // Send command + Enter to the active terminal
    onSendCommand(cmd.command + '\r');
  }, [onSendCommand]);

  const handleContextMenu = useCallback((e, cmd) => {
    e.preventDefault();
    e.stopPropagation();
    setContextMenu({ x: e.clientX, y: e.clientY - 4, cmd });
  }, []);

  return (
    <>
      <div className="command-bar">
        {/* Group tabs */}
        {groups.length > 0 && (
          <div className="cmd-groups">
            {groups.map((g) => (
              <button
                key={g}
                className={`cmd-group-tab ${currentGroup === g ? 'active' : ''}`}
                onClick={() => setActiveGroup(g)}
              >
                {g}
                <span className="cmd-group-count">
                  {commands.filter((c) => (c.group?.trim() || 'Default') === g).length}
                </span>
              </button>
            ))}
          </div>
        )}

        {/* Command buttons */}
        <div className="cmd-list">
          {visibleCmds.map((cmd) => (
            <button
              key={cmd.id}
              className="cmd-btn"
              style={cmd.color ? { '--cmd-color': cmd.color, borderColor: cmd.color } : {}}
              onClick={() => handleClick(cmd)}
              onContextMenu={(e) => handleContextMenu(e, cmd)}
              title={cmd.command}
            >
              {cmd.color && <span className="cmd-dot" style={{ background: cmd.color }} />}
              {cmd.label}
            </button>
          ))}

          {visibleCmds.length === 0 && commands.length > 0 && (
            <span style={{ fontSize: 11, color: 'var(--text-muted)', padding: '0 8px', lineHeight: '28px' }}>
              该分组暂无命令
            </span>
          )}
        </div>

        {/* Add button */}
        <button
          className="cmd-add-btn"
          onClick={() => { setEditingCmd(null); setDialogOpen(true); }}
          title="添加常用命令"
        >
          +
        </button>
      </div>

      {/* Dialog */}
      {dialogOpen && (
        <CommandDialog
          cmd={editingCmd}
          groups={groups.length > 0 ? groups : ['Default']}
          onSave={handleSave}
          onClose={() => { setDialogOpen(false); setEditingCmd(null); }}
        />
      )}

      {/* Context menu */}
      {contextMenu && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          cmd={contextMenu.cmd}
          onEdit={(c) => { setEditingCmd(c); setDialogOpen(true); }}
          onDelete={handleDelete}
          onClose={() => setContextMenu(null)}
        />
      )}
    </>
  );
}
