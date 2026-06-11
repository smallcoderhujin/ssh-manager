import React, { useState, useEffect, useRef } from 'react';

function useClickOutside(ref, onClose) {
  useEffect(() => {
    const handler = (e) => { if (ref.current && !ref.current.contains(e.target)) onClose(); };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [onClose]);
}

function Menu({ label, items }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useClickOutside(ref, () => setOpen(false));

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button
        className={`menubar-item${open ? ' active' : ''}`}
        onClick={() => setOpen((v) => !v)}
      >
        {label}
      </button>
      {open && (
        <div className="menubar-dropdown">
          {items.map((item, i) =>
            item === 'separator' ? (
              <div key={i} className="menubar-separator" />
            ) : (
              <button
                key={i}
                className="menubar-dropdown-item"
                onClick={() => { setOpen(false); item.action(); }}
                disabled={item.disabled}
              >
                <span className="menubar-dropdown-label">{item.label}</span>
                {item.shortcut && <span className="menubar-dropdown-shortcut">{item.shortcut}</span>}
              </button>
            )
          )}
        </div>
      )}
    </div>
  );
}

export default function MenuBar({
  onNewTab, onAddSession,
  onImportSshConfig, onImportSessions, onExportSessions,
}) {
  const menus = [
    {
      label: '文件',
      items: [
        { label: '新建标签页', shortcut: '⌘T', action: onNewTab },
        'separator',
        { label: '新建会话', action: onAddSession },
        'separator',
        { label: '导入 SSH Config', action: onImportSshConfig },
        { label: '导入会话…', action: onImportSessions },
        { label: '导出会话…', action: onExportSessions },
      ],
    },
  ];

  return (
    <div className="menubar">
      {menus.map((m) => (
        <Menu key={m.label} label={m.label} items={m.items} />
      ))}
    </div>
  );
}
