import React, { useRef, useState } from 'react';

export default function TabBar({
  tabs, activeTabId, onSelect, onClose, onNew, onDuplicate, onReorder,
  onAddSession, onImportSshConfig, onImportSessions, onExportSessions,
}) {
  const isWin = window.electronAPI?.platform === 'win32';
  const api = window.electronAPI?.window;

  // Drag-to-reorder state
  const dragIndexRef = useRef(null);
  const [insertAt, setInsertAt] = useState(null); // index to insert before (0..tabs.length)

  const handleDragStart = (e, index) => {
    dragIndexRef.current = index;
    e.dataTransfer.effectAllowed = 'move';
    // ghost image: use the tab element itself (default)
  };

  const handleDragOver = (e, index) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const rect = e.currentTarget.getBoundingClientRect();
    const insertIndex = e.clientX < rect.left + rect.width / 2 ? index : index + 1;
    setInsertAt(insertIndex);
  };

  const handleDrop = (e, index) => {
    e.preventDefault();
    const from = dragIndexRef.current;
    if (from === null || from === undefined) return;
    const to = insertAt ?? index;
    if (from !== to && from !== to - 1) {
      const next = [...tabs];
      const [moved] = next.splice(from, 1);
      const insertIndex = to > from ? to - 1 : to;
      next.splice(insertIndex, 0, moved);
      onReorder?.(next);
    }
    dragIndexRef.current = null;
    setInsertAt(null);
  };

  const handleDragEnd = () => {
    dragIndexRef.current = null;
    setInsertAt(null);
  };

  return (
    <div className="tabbar" onDragOver={(e) => e.preventDefault()}>
      <button
        className="tabbar-menu-btn"
        onMouseDown={() => window.electronAPI?.showPopupMenu()}
        title="菜单"
      >
        ☰
      </button>
      {tabs.map((tab, idx) => (
        <Tab
          key={tab.id}
          tab={tab}
          index={idx}
          isActive={tab.id === activeTabId}
          insertBefore={insertAt === idx}
          insertAfter={insertAt === idx + 1 && idx === tabs.length - 1}
          onSelect={() => onSelect(tab.id)}
          onClose={(e) => { e.stopPropagation(); onClose(tab.id); }}
          onDuplicate={() => onDuplicate(tab)}
          onDragStart={(e) => handleDragStart(e, idx)}
          onDragOver={(e) => handleDragOver(e, idx)}
          onDrop={(e) => handleDrop(e, idx)}
          onDragEnd={handleDragEnd}
        />
      ))}
      <button className="tab-add" onClick={() => onNew()} title="新建标签页 (⌘T)">+</button>
      <div className="tabbar-drag-spacer" />
      {isWin && api && (
        <div style={{ display: 'flex', flexShrink: 0 }}>
          <button className="win-btn" onClick={() => api.minimize()} title="最小化">─</button>
          <button className="win-btn" onClick={() => api.maximize()} title="最大化/还原">□</button>
          <button className="win-btn close" onClick={() => api.close()} title="关闭">✕</button>
        </div>
      )}
    </div>
  );
}

function Tab({ tab, index, isActive, insertBefore, insertAfter, onSelect, onClose, onDuplicate,
               onDragStart, onDragOver, onDrop, onDragEnd }) {
  const statusClass =
    tab.status === 'connected' ? 'connected'
    : tab.status === 'disconnected' ? 'disconnected'
    : 'connecting';

  return (
    <div
      className={`tab ${isActive ? 'active' : ''}${insertBefore ? ' tab-drop-before' : ''}${insertAfter ? ' tab-drop-after' : ''}`}
      draggable
      onClick={onSelect}
      onDoubleClick={onDuplicate}
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDrop={onDrop}
      onDragEnd={onDragEnd}
      title={`${tab.title}${index < 9 ? ` (⌘${index + 1})` : ''} · 双击复制`}
    >
      <span className={`tab-status ${statusClass}`} />
      <span className="tab-title">{tab.title}</span>
      <button className="tab-close" onClick={onClose} title="关闭标签页 (⌘W)">✕</button>
    </div>
  );
}
