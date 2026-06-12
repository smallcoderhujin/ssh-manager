import React, { useEffect, useRef, useCallback, useState } from 'react';
import { Terminal } from 'xterm';
import { FitAddon } from 'xterm-addon-fit';
import { WebLinksAddon } from 'xterm-addon-web-links';
import { WebglAddon } from 'xterm-addon-webgl';
import 'xterm/css/xterm.css';

const TERMINAL_THEME = {
  background: '#0d0d0d',
  foreground: '#e8e8e8',
  cursor: '#4a9eff',
  cursorAccent: '#0d0d0d',
  black: '#1a1a1a', brightBlack: '#555555',
  red: '#ff5f57', brightRed: '#ff6e67',
  green: '#28c840', brightGreen: '#5af78e',
  yellow: '#ffbd2e', brightYellow: '#ffea2e',
  blue: '#4a9eff', brightBlue: '#6fb3f9',
  magenta: '#b48bff', brightMagenta: '#c7a8ff',
  cyan: '#5ec4d3', brightCyan: '#80d4e0',
  white: '#c7c7c7', brightWhite: '#ffffff',
  selectionBackground: 'rgba(74, 158, 255, 0.3)',
};

function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

const GUTTER_WIDTH = 52;  // px — fits line numbers up to 99999
const LINE_HEIGHT = 1.3;
const GUTTER_OVERSCAN = 30; // extra lines rendered above/below viewport

function nowStr() {
  const d = new Date();
  return d.toTimeString().slice(0, 8);
}

export default function TerminalPane({
  splitId, tabId, sessionConfig, quickConnect, password,
  isActive, onStatusChange, onClose, onReady,
}) {
  const containerRef = useRef(null);
  const gutterInnerRef = useRef(null);
  const termRef = useRef(null);
  const fitAddonRef = useRef(null);
  const terminalIdRef = useRef(null);

  const [status, setStatus] = useState('connecting');
  const [exitInfo, setExitInfo] = useState(null);
  const [fontSize, setFontSize] = useState(14);
  const fontSizeRef = useRef(14);
  const [zmodem, setZmodem] = useState(null); // null | { direction, name, received, total, done, savedPath }

  // Gutter state — kept in refs to avoid excessive re-renders, flushed to state on scroll/data
  const lineTimestampsRef = useRef(new Map()); // bufferLine -> "HH:MM:SS"
  const trackedLinesRef = useRef(0);           // how many lines we've assigned timestamps
  const [gutterViewport, setGutterViewport] = useState({ y: 0, rows: 24, total: 0, cellHeight: fontSize * LINE_HEIGHT });
  const cellHeightRef = useRef(fontSize * LINE_HEIGHT);

  const dataCleanupRef = useRef(null);
  const exitCleanupRef = useRef(null);
  const reconnectRef = useRef(null);
  // Mirrors `status` state synchronously so onData closures can read it without stale captures
  const statusRef = useRef('connecting');

  const updateStatus = useCallback((s) => {
    statusRef.current = s;
    setStatus(s);
    onStatusChange?.(s);
  }, [onStatusChange]);

  // ── Font size ────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!window.electronAPI) return;
    window.electronAPI.settings.get('fontSize').then((saved) => {
      if (saved >= 8 && saved <= 32) { setFontSize(saved); fontSizeRef.current = saved; }
    });
  }, []);

  const changeFontSize = useCallback((next) => {
    setFontSize(next);
    fontSizeRef.current = next;
    window.electronAPI?.settings.set('fontSize', next);
  }, []);

  useEffect(() => {
    const handler = (e) => {
      if (!e.metaKey && !e.ctrlKey) return;
      if (e.key === '=' || e.key === '+') { e.preventDefault(); changeFontSize(Math.min(fontSizeRef.current + 1, 32)); }
      else if (e.key === '-') { e.preventDefault(); changeFontSize(Math.max(fontSizeRef.current - 1, 8)); }
      else if (e.key === '0') { e.preventDefault(); changeFontSize(13); }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [changeFontSize]);

  useEffect(() => {
    if (termRef.current) {
      termRef.current.options.fontSize = fontSize;
      try { fitAddonRef.current?.fit(); } catch (_) {}
    }
  }, [fontSize]);

  // ── Terminal init ─────────────────────────────────────────────────────────
  useEffect(() => {
    if (!containerRef.current) return;

    const term = new Terminal({
      fontFamily: '"JetBrains Mono", "Cascadia Code", "Cascadia Mono", "Fira Code", "SF Mono", "Menlo", "Consolas", "Courier New", monospace',
      fontSize,
      lineHeight: LINE_HEIGHT,
      theme: TERMINAL_THEME,
      cursorBlink: true,
      cursorStyle: 'bar',
      scrollback: 10000,
      macOptionIsMeta: true,
      macOptionClickForcesSelection: false,
      rightClickSelectsWord: false,
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.loadAddon(new WebLinksAddon());
    term.open(containerRef.current);
    termRef.current = term;
    fitAddonRef.current = fitAddon;

    // Use WebGL renderer for correct wrapped-line rendering.
    // The default canvas renderer has a known dirty-row tracking bug where
    // continuation rows of wrapped lines are not repainted, appearing blank.
    // Fall back to canvas silently if WebGL is unavailable.
    try {
      const webgl = new WebglAddon();
      webgl.onContextLoss(() => webgl.dispose());
      term.loadAddon(webgl);
    } catch (_) {}

    // ── Gutter sync ──
    // Read the actual cell height from xterm's internal renderer so the gutter
    // stays pixel-perfectly aligned regardless of font metrics or DPI.
    const readCellHeight = () => {
      const ch = term._core?._renderService?._renderer?.value?._dimensions?.device?.cell?.height
               ?? term._core?._renderService?.dimensions?.device?.cell?.height;
      if (ch && ch > 0) {
        const css = ch / (window.devicePixelRatio || 1);
        cellHeightRef.current = css;
      }
    };
    const syncGutter = () => {
      readCellHeight();
      const buf = term.buffer.active;
      setGutterViewport({ y: buf.viewportY, rows: term.rows, total: buf.length, cellHeight: cellHeightRef.current });
    };
    term.onScroll(syncGutter);
    term.onResize(syncGutter);

    // Track timestamps: called after xterm processes each write
    const trackTimestamps = () => {
      const total = term.buffer.active.length;
      const ts = nowStr();
      for (let i = trackedLinesRef.current; i < total; i++) {
        if (!lineTimestampsRef.current.has(i)) lineTimestampsRef.current.set(i, ts);
      }
      trackedLinesRef.current = total;
      syncGutter();
    };

    // Select → copy
    term.onSelectionChange(() => {
      const sel = term.getSelection();
      if (sel && window.electronAPI) window.electronAPI.clipboard.writeText(sel);
    });

    // Right-click → paste
    const el = containerRef.current;
    const onContextMenu = (e) => {
      e.preventDefault();
      if (!window.electronAPI) return;
      const text = window.electronAPI.clipboard.readText();
      if (text && terminalIdRef.current !== null)
        window.electronAPI.terminal.write(terminalIdRef.current, text);
    };
    el.addEventListener('contextmenu', onContextMenu);

    setTimeout(() => { try { fitAddon.fit(); } catch (_) {} }, 50);

    // ── PTY session ──
    const initTerminal = async () => {
      if (!window.electronAPI) {
        term.writeln('\x1b[1;34mSSH Manager\x1b[0m — Electron required');
        updateStatus('disconnected');
        return;
      }

      const result = await window.electronAPI.terminal.create({
        sessionConfig, quickConnect, password, cols: term.cols, rows: term.rows,
      });

      if (result.error) {
        term.writeln(`\x1b[31mError:\x1b[0m ${result.error}`);
        updateStatus('disconnected');
        return;
      }

      terminalIdRef.current = result.id;
      updateStatus('connected');
      // Register sendCommand fn so CommandBar can write to this terminal
      onReady?.((text) => {
        if (terminalIdRef.current !== null)
          window.electronAPI.terminal.write(terminalIdRef.current, text);
      });

      dataCleanupRef.current = window.electronAPI.terminal.onData(({ id, data }) => {
        if (id === result.id) {
          // data is Uint8Array (Buffer serialized by Electron IPC) or string
          term.write(data instanceof Uint8Array ? data : data, trackTimestamps);
        }
      });

      const zmodemCleanup = window.electronAPI.terminal.onZmodem((msg) => {
        if (msg.id !== result.id) return;
        if (msg.type === 'start') {
          setZmodem({ direction: msg.direction, name: '', received: 0, total: 0, done: false });
        } else if (msg.type === 'progress') {
          setZmodem((z) => z ? { ...z, name: msg.name, received: msg.received, total: msg.total } : z);
        } else if (msg.type === 'done') {
          setZmodem((z) => z ? { ...z, name: msg.name, received: msg.size, total: msg.size, done: true, savedPath: msg.savedPath } : z);
        } else if (msg.type === 'end') {
          setTimeout(() => setZmodem(null), 2000);
        }
      });
      // store cleanup alongside data cleanup
      const origDataCleanup = dataCleanupRef.current;
      dataCleanupRef.current = () => { origDataCleanup(); zmodemCleanup(); };

      exitCleanupRef.current = window.electronAPI.terminal.onExit(({ id, exitCode, signal }) => {
        if (id === result.id) {
          terminalIdRef.current = null;
          updateStatus('disconnected');
          setExitInfo({ exitCode, signal });
          term.writeln('');
          term.writeln(`\x1b[33m[Process exited with code ${exitCode}${signal ? `, signal ${signal}` : ''}]\x1b[0m`);
          if (sessionConfig || quickConnect) {
            term.writeln('\x1b[2m[Press Enter to reconnect]\x1b[0m');
          }
        }
      });

      term.onData((data) => {
        if (statusRef.current === 'disconnected') {
          if (data === '\r' && reconnectRef.current) reconnectRef.current();
        } else if (terminalIdRef.current !== null) {
          window.electronAPI.terminal.write(terminalIdRef.current, data);
        }
      });

      term.onResize(({ cols, rows }) => {
        if (terminalIdRef.current !== null)
          window.electronAPI.terminal.resize(terminalIdRef.current, cols, rows);
      });
    };

    initTerminal();

    return () => {
      el.removeEventListener('contextmenu', onContextMenu);
      if (dataCleanupRef.current) dataCleanupRef.current();
      if (exitCleanupRef.current) exitCleanupRef.current();
      if (terminalIdRef.current !== null && window.electronAPI)
        window.electronAPI.terminal.kill(terminalIdRef.current);
      term.dispose();
    };
  }, []);

  // Resize observer
  useEffect(() => {
    if (!containerRef.current) return;
    const observer = new ResizeObserver(() => {
      try { fitAddonRef.current?.fit(); } catch (_) {}
    });
    observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (isActive && termRef.current) {
      setTimeout(() => {
        termRef.current?.focus();
        try { fitAddonRef.current?.fit(); } catch (_) {}
      }, 50);
    }
  }, [isActive]);

  // ── Reconnect ─────────────────────────────────────────────────────────────
  const handleReconnect = useCallback(async () => {
    if (!window.electronAPI || !termRef.current) return;
    setExitInfo(null);
    updateStatus('connecting');
    termRef.current.writeln('');
    termRef.current.writeln('\x1b[33m[Reconnecting…]\x1b[0m');

    const result = await window.electronAPI.terminal.create({
      sessionConfig, quickConnect, password,
      cols: termRef.current.cols, rows: termRef.current.rows,
    });

    if (result.error) {
      termRef.current.writeln(`\x1b[31mError:\x1b[0m ${result.error}`);
      updateStatus('disconnected');
      return;
    }

    terminalIdRef.current = result.id;
    updateStatus('connected');

    if (dataCleanupRef.current) dataCleanupRef.current();
    if (exitCleanupRef.current) exitCleanupRef.current();

    const trackTimestamps = () => {
      const total = termRef.current.buffer.active.length;
      const ts = nowStr();
      for (let i = trackedLinesRef.current; i < total; i++) {
        if (!lineTimestampsRef.current.has(i)) lineTimestampsRef.current.set(i, ts);
      }
      trackedLinesRef.current = total;
      const buf = termRef.current.buffer.active;
      setGutterViewport({ y: buf.viewportY, rows: termRef.current.rows, total: buf.length });
    };

    const dataUnsub = window.electronAPI.terminal.onData(({ id, data }) => {
      if (id === result.id) termRef.current?.write(data, trackTimestamps);
    });
    const zmodemUnsub = window.electronAPI.terminal.onZmodem((msg) => {
      if (msg.id !== result.id) return;
      if (msg.type === 'start') setZmodem({ direction: msg.direction, name: '', received: 0, total: 0, done: false });
      else if (msg.type === 'progress') setZmodem((z) => z ? { ...z, name: msg.name, received: msg.received, total: msg.total } : z);
      else if (msg.type === 'done') setZmodem((z) => z ? { ...z, name: msg.name, received: msg.size, total: msg.size, done: true, savedPath: msg.savedPath } : z);
      else if (msg.type === 'end') setTimeout(() => setZmodem(null), 2000);
    });
    dataCleanupRef.current = () => { dataUnsub(); zmodemUnsub(); };

    exitCleanupRef.current = window.electronAPI.terminal.onExit(({ id, exitCode, signal }) => {
      if (id === result.id) {
        terminalIdRef.current = null;
        updateStatus('disconnected');
        setExitInfo({ exitCode, signal });
        termRef.current?.writeln('');
        termRef.current?.writeln(`\x1b[33m[Process exited with code ${exitCode}${signal ? `, signal ${signal}` : ''}]\x1b[0m`);
        if (sessionConfig || quickConnect) {
          termRef.current?.writeln('\x1b[2m[Press Enter to reconnect]\x1b[0m');
        }
      }
    });
  }, [sessionConfig, quickConnect, password]);
  reconnectRef.current = (sessionConfig || quickConnect) ? handleReconnect : null;

  // ── Gutter render ─────────────────────────────────────────────────────────
  const { y: viewportY, rows, total, cellHeight } = gutterViewport;

  const startLine = Math.max(0, viewportY - GUTTER_OVERSCAN);
  const endLine = Math.min(total - 1, viewportY + rows + GUTTER_OVERSCAN);
  const gutterLines = [];
  for (let i = startLine; i <= endLine; i++) gutterLines.push(i);

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', background: TERMINAL_THEME.background, position: 'relative' }}>
      {/* Split pane header */}
      {onClose && (
        <div className="terminal-toolbar" style={{ flexShrink: 0 }}>
          <span className="terminal-toolbar-title" style={{ fontSize: 11 }}>
            {sessionConfig ? `${sessionConfig.user || ''}@${sessionConfig.host}` : quickConnect || 'Terminal'}
          </span>
          <button className="terminal-toolbar-btn" onClick={onClose} title="Close pane">✕</button>
        </div>
      )}

      {/* Font size controls */}
      <div
        style={{ position: 'absolute', top: 4, right: 8, zIndex: 10, display: 'flex', alignItems: 'center', gap: 4, opacity: 0.4, transition: 'opacity 0.15s' }}
        onMouseEnter={e => e.currentTarget.style.opacity = 1}
        onMouseLeave={e => e.currentTarget.style.opacity = 0.4}
      >
        <button className="terminal-toolbar-btn" style={{ fontSize: 14, lineHeight: 1, padding: '0 5px' }} onClick={() => changeFontSize(Math.max(fontSize - 1, 8))} title="减小字体 (⌘-)">A-</button>
        <span style={{ fontSize: 11, color: 'var(--text-muted)', minWidth: 24, textAlign: 'center' }}>{fontSize}</span>
        <button className="terminal-toolbar-btn" style={{ fontSize: 14, lineHeight: 1, padding: '0 5px' }} onClick={() => changeFontSize(Math.min(fontSize + 1, 32))} title="增大字体 (⌘+)">A+</button>
        <button className="terminal-toolbar-btn" style={{ fontSize: 10, padding: '0 5px' }} onClick={() => changeFontSize(14)} title="重置字体 (⌘0)">reset</button>
      </div>

      {/* Gutter + Terminal row */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'row', overflow: 'hidden' }}>

        {/* ── Gutter ── */}
        <div style={{
          width: GUTTER_WIDTH,
          flexShrink: 0,
          overflow: 'hidden',
          position: 'relative',
          background: '#111214',
          borderRight: '1px solid #252525',
          userSelect: 'none',
        }}>
          <div
            ref={gutterInnerRef}
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              right: 0,
              transform: `translateY(${(startLine - viewportY) * cellHeight}px)`,
              willChange: 'transform',
            }}
          >
            {gutterLines.map((lineIdx) => (
              <div
                key={lineIdx}
                style={{
                  height: cellHeight,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'flex-end',
                  paddingRight: 6,
                  overflow: 'hidden',
                }}
              >
                <span style={{
                  fontSize: Math.max(fontSize - 2, 9),
                  fontFamily: '"SF Mono", "Fira Code", monospace',
                  color: '#3a5a6a',
                  whiteSpace: 'nowrap',
                }}>
                  {lineIdx + 1}
                </span>
              </div>
            ))}
          </div>
        </div>

        {/* ── Zmodem progress overlay ── */}
        {zmodem && (
          <div style={{
            position: 'absolute', inset: 0, zIndex: 20,
            background: 'rgba(0,0,0,0.72)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}>
            <div style={{
              background: '#1a1d23', border: '1px solid #2e3440',
              borderRadius: 8, padding: '20px 28px', minWidth: 320, maxWidth: 420,
            }}>
              <div style={{ fontSize: 13, color: '#aaa', marginBottom: 10 }}>
                {zmodem.direction === 'receive' ? '⬇ 下载中' : '⬆ 上传中'}
                {zmodem.done ? ' — 完成' : ''}
              </div>
              {zmodem.name && (
                <div style={{ fontSize: 12, color: '#e8e8e8', marginBottom: 10, wordBreak: 'break-all' }}>
                  {zmodem.name}
                </div>
              )}
              {/* progress bar */}
              <div style={{ background: '#111', borderRadius: 4, height: 6, marginBottom: 10, overflow: 'hidden' }}>
                <div style={{
                  height: '100%', borderRadius: 4,
                  background: zmodem.done ? '#28c840' : '#4a9eff',
                  width: zmodem.total > 0
                    ? `${Math.round(zmodem.received / zmodem.total * 100)}%`
                    : (zmodem.received > 0 ? '100%' : '0%'),
                  transition: 'width 0.2s',
                }} />
              </div>
              <div style={{ fontSize: 11, color: '#666', display: 'flex', justifyContent: 'space-between' }}>
                <span>{formatBytes(zmodem.received)}{zmodem.total > 0 ? ` / ${formatBytes(zmodem.total)}` : ''}</span>
                {zmodem.total > 0 && <span>{Math.round(zmodem.received / zmodem.total * 100)}%</span>}
              </div>
              {zmodem.done && zmodem.savedPath && (
                <button
                  style={{ marginTop: 12, fontSize: 12, color: '#4a9eff', background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}
                  onClick={() => window.electronAPI?.shell.showItemInFolder(zmodem.savedPath)}
                >
                  在 Finder 中显示 →
                </button>
              )}
            </div>
          </div>
        )}

        {/* ── xterm ── */}
        <div
          ref={containerRef}
          className="terminal-pane"
          style={{ flex: 1, overflow: 'hidden' }}
          onClick={() => termRef.current?.focus()}
        />
      </div>

      {/* Reconnect bar */}
      {exitInfo && (
        <div style={{ padding: '6px 12px', background: 'rgba(255,189,46,0.1)', borderTop: '1px solid rgba(255,189,46,0.3)', display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0 }}>
          <span style={{ fontSize: 12, color: 'var(--warning)' }}>Session ended (exit code {exitInfo.exitCode})</span>
          {(sessionConfig || quickConnect) && (
            <button className="btn sm primary" onClick={handleReconnect}>Reconnect</button>
          )}
        </div>
      )}
    </div>
  );
}
