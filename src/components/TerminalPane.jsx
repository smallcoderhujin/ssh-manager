import React, { useEffect, useRef, useCallback, useState } from 'react';
import { Terminal } from 'xterm';
import { FitAddon } from 'xterm-addon-fit';
import { WebLinksAddon } from 'xterm-addon-web-links';
import { WebglAddon } from 'xterm-addon-webgl';
import { SearchAddon } from 'xterm-addon-search';
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
  isActive, onStatusChange, onClose, onReady, onActivity,
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

  const webglAddonRef = useRef(null); // only the active tab holds a WebGL context
  const searchAddonRef = useRef(null);
  const [searchVisible, setSearchVisible] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResult, setSearchResult] = useState(null); // { current, total } | null
  const searchInputRef = useRef(null);
  const dataCleanupRef = useRef(null);
  const exitCleanupRef = useRef(null);
  const reconnectRef = useRef(null);
  const isComposingRef = useRef(false);
  const isActiveRef = useRef(isActive);
  const onActivityRef = useRef(onActivity);
  // Mirrors `status` state synchronously so onData closures can read it without stale captures
  const statusRef = useRef('connecting');

  // Keep refs in sync so PTY data closures always see current values
  isActiveRef.current = isActive;
  onActivityRef.current = onActivity;

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
      else if (e.key === 'f' || e.key === 'F') {
        if (!isActiveRef.current) return;
        e.preventDefault();
        setSearchVisible(true);
        setTimeout(() => searchInputRef.current?.select(), 30);
      }
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
      allowProposedApi: true,
      overviewRulerWidth: 12,
    });

    const fitAddon = new FitAddon();
    const searchAddon = new SearchAddon();
    term.loadAddon(fitAddon);
    term.loadAddon(searchAddon);
    term.loadAddon(new WebLinksAddon());
    term.open(containerRef.current);
    searchAddonRef.current = searchAddon;
    termRef.current = term;
    fitAddonRef.current = fitAddon;

    // WebGL is loaded/unloaded by the isActive effect below so only the
    // currently-visible tab holds a WebGL context. Browsers cap concurrent
    // WebGL contexts at ~8; exceeding that causes "Too many active WebGL
    // contexts" warnings and dimension errors in inactive terminals.

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

    // Select → copy (skip when search bar is open to avoid overwriting clipboard with match highlights)
    term.onSelectionChange(() => {
      if (searchInputRef.current === document.activeElement) return;
      const sel = term.getSelection();
      if (sel && window.electronAPI) window.electronAPI.clipboard.writeText(sel);
    });

    // Disable IME on the xterm textarea so Windows input methods don't activate
    // when the terminal gets focus. inputmode="none" tells Chromium not to engage
    // TSF/IME; the compositionstart listener cancels any composition that slips
    // through (e.g. when the user presses a CJK hotkey before focus settles).
    const setupImeHint = () => {
      const ta = term.textarea;
      if (!ta) return;
      ta.setAttribute('inputmode', 'none');
      ta.setAttribute('lang', 'en');
      ta.setAttribute('autocomplete', 'off');
      ta.setAttribute('autocorrect', 'off');
      ta.setAttribute('autocapitalize', 'off');
      ta.setAttribute('spellcheck', 'false');
      // On Windows, TSF-based IMEs (Microsoft Pinyin on Win10/11) ignore
      // inputmode="none", so we blur the textarea on compositionstart to
      // cancel the composition and dismiss the candidate window, then refocus.
      // On macOS this blur/refocus is NOT needed — inputmode="none" is enough —
      // and doing it leaves isComposingRef stuck at true, permanently blocking input.
      const isWin = window.electronAPI?.platform === 'win32';
      ta.addEventListener('compositionstart', () => {
        isComposingRef.current = true;
        if (isWin) {
          ta.blur();
          requestAnimationFrame(() => {
            isComposingRef.current = false;
            ta.focus();
          });
        }
      }, true);
      ta.addEventListener('compositionend', () => {
        // Always reset after a brief delay so xterm's deferred onData fires first.
        setTimeout(() => { isComposingRef.current = false; }, 50);
      }, true);
    };
    if (term.textarea) setupImeHint();
    else requestAnimationFrame(setupImeHint);

    // Right-click → paste + scroll to bottom
    const el = containerRef.current;
    const onContextMenu = (e) => {
      e.preventDefault();
      if (!window.electronAPI) return;
      const text = window.electronAPI.clipboard.readText();
      if (text && terminalIdRef.current !== null) {
        window.electronAPI.terminal.write(terminalIdRef.current, text);
        term.scrollToBottom();
      }
    };
    el.addEventListener('contextmenu', onContextMenu);

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
      // Re-sync dimensions: fit() may have changed cols/rows between create() call and response
      window.electronAPI.terminal.resize(result.id, term.cols, term.rows);
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
          // Notify parent when new output arrives in a background tab
          if (!isActiveRef.current) onActivityRef.current?.();
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
          // Soft-reset terminal modes (DECSTR) so lingering state from vim/less/htop
          // (application cursor keys, mouse tracking, focus tracking, etc.) doesn't
          // cause scroll wheel events to be sent as escape sequences on next command.
          term.write('\x1b[!p');
          term.writeln('');
          term.writeln(`\x1b[33m[Process exited with code ${exitCode}${signal ? `, signal ${signal}` : ''}]\x1b[0m`);
          if (sessionConfig || quickConnect) {
            term.writeln('\x1b[2m[Press Enter to reconnect]\x1b[0m');
          }
        }
      });

      term.onData((data) => {
        if (isComposingRef.current) return;
        if (statusRef.current === 'disconnected') {
          if (data === '\r' && reconnectRef.current) reconnectRef.current();
        } else if (terminalIdRef.current !== null) {
          window.electronAPI.terminal.write(terminalIdRef.current, data);
          // Scroll to bottom on Enter so output is always visible
          if (data === '\r') term.scrollToBottom();
        }
      });

      term.onResize(({ cols, rows }) => {
        if (terminalIdRef.current !== null)
          window.electronAPI.terminal.resize(terminalIdRef.current, cols, rows);
      });
    };

    // Wait until the container has a real layout size before creating the PTY.
    // requestAnimationFrame is not enough in Electron — use ResizeObserver so we
    // only proceed once clientWidth > 0 (real layout dimensions are available).
    // This prevents the PTY from being told 80 cols (xterm default) while the
    // terminal container is actually wider.
    let started = false;
    const startObserver = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width ?? 0;
      if (w > 0 && !started) {
        started = true;
        startObserver.disconnect();
        try { fitAddon.fit(); } catch (_) {}
        initTerminal();
      }
    });
    startObserver.observe(containerRef.current);

    return () => {
      startObserver.disconnect();
      el.removeEventListener('contextmenu', onContextMenu);
      if (dataCleanupRef.current) dataCleanupRef.current();
      if (exitCleanupRef.current) exitCleanupRef.current();
      if (terminalIdRef.current !== null && window.electronAPI)
        window.electronAPI.terminal.kill(terminalIdRef.current);
      // Dispose WebGL addon BEFORE the terminal to avoid
      // "Cannot read properties of undefined (reading 'onRequestRedraw')"
      // thrown by xterm-addon-webgl's internal cleanup, which crashes React.
      try { webglAddonRef.current?.dispose(); } catch (_) {}
      webglAddonRef.current = null;
      searchAddonRef.current = null;
      try { term.dispose(); } catch (_) {}
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
      // Reset lingering terminal modes (DECCKM, mouse tracking, focus tracking)
      // so that scrolling with the mouse wheel doesn't send cursor-key escape
      // sequences to the PTY when commands like tail/cat are running.
      if (terminalIdRef.current !== null) {
        window.electronAPI?.terminal.write(terminalIdRef.current, '\x1b[!p');
      }
    }
  }, [isActive]);

  // Load WebGL only for the active tab; dispose it for inactive tabs.
  // This keeps concurrent WebGL contexts at 1, avoiding the browser's
  // "Too many active WebGL contexts" limit that causes dimension crashes.
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;

    if (isActive) {
      if (!webglAddonRef.current) {
        try {
          const addon = new WebglAddon();
          addon.onContextLoss(() => {
            try { addon.dispose(); } catch (_) {}
            webglAddonRef.current = null;
          });
          term.loadAddon(addon);
          webglAddonRef.current = addon;
        } catch (_) {}
      }
    } else {
      if (webglAddonRef.current) {
        try { webglAddonRef.current.dispose(); } catch (_) {}
        webglAddonRef.current = null;
      }
    }
  }, [isActive]);

  // Re-seat textarea focus when the Electron window regains focus so that
  // inputmode="none" takes effect and the Windows IME stays off.
  useEffect(() => {
    const unsub = window.electronAPI?.window?.onFocus?.(() => {
      const ta = termRef.current?.textarea;
      if (!ta) return;
      ta.blur();
      requestAnimationFrame(() => ta.focus());
    });
    return () => unsub?.();
  }, []);

  // ── Search ────────────────────────────────────────────────────────────────
  const doSearch = useCallback((query, direction = 'next') => {
    const addon = searchAddonRef.current;
    if (!addon || !query) { setSearchResult(null); return; }
    const opts = {
      regex: false, wholeWord: false, caseSensitive: false,
      decorations: {
        matchBackground: '#4a9eff33',
        matchBorder: '#4a9eff',
        matchOverviewRuler: '#4a9eff',
        activeMatchBackground: '#4a9effaa',
        activeMatchBorder: '#4a9eff',
        activeMatchColorOverviewRuler: '#4a9eff',
      },
    };
    const found = direction === 'next'
      ? addon.findNext(query, opts)
      : addon.findPrevious(query, opts);
    setSearchResult(found ? { found: true } : { found: false });
  }, []);

  const closeSearch = useCallback(() => {
    setSearchVisible(false);
    setSearchQuery('');
    setSearchResult(null);
    searchAddonRef.current?.clearDecorations?.();
    termRef.current?.focus();
  }, []);

  const handleSearchKeyDown = useCallback((e) => {
    if (e.key === 'Escape') { closeSearch(); }
    else if (e.key === 'Enter') {
      e.preventDefault();
      doSearch(searchQuery, e.shiftKey ? 'prev' : 'next');
    }
  }, [searchQuery, doSearch, closeSearch]);

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
      if (id === result.id) {
        termRef.current?.write(data, trackTimestamps);
        if (!isActiveRef.current) onActivityRef.current?.();
      }
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
        termRef.current?.write('\x1b[!p');
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

      {/* Search bar */}
      {searchVisible && (
        <div style={{
          flexShrink: 0, display: 'flex', alignItems: 'center', gap: 6,
          padding: '5px 10px', background: '#1a1d23', borderTop: '1px solid #2e3440',
        }}>
          <span style={{ fontSize: 12, color: '#666', whiteSpace: 'nowrap' }}>查找:(F)</span>
          <input
            ref={searchInputRef}
            value={searchQuery}
            onChange={(e) => {
              setSearchQuery(e.target.value);
              doSearch(e.target.value, 'next');
            }}
            onKeyDown={handleSearchKeyDown}
            placeholder="搜索…"
            style={{
              flex: 1, maxWidth: 260, background: '#111', border: '1px solid #3a3a3a',
              borderRadius: 4, color: '#e8e8e8', fontSize: 13, padding: '3px 8px', outline: 'none',
              ...(searchResult?.found === false ? { borderColor: '#ff5f57' } : {}),
            }}
            autoFocus
          />
          {searchResult?.found === false && (
            <span style={{ fontSize: 11, color: '#ff5f57', whiteSpace: 'nowrap' }}>无结果</span>
          )}
          <button
            style={{ fontSize: 16, lineHeight: 1, padding: '1px 6px', background: 'none', border: '1px solid #3a3a3a', borderRadius: 4, color: '#888', cursor: 'pointer' }}
            onClick={() => doSearch(searchQuery, 'prev')} title="上一个 (Shift+Enter)">↑</button>
          <button
            style={{ fontSize: 16, lineHeight: 1, padding: '1px 6px', background: 'none', border: '1px solid #3a3a3a', borderRadius: 4, color: '#888', cursor: 'pointer' }}
            onClick={() => doSearch(searchQuery, 'next')} title="下一个 (Enter)">↓</button>
          <button
            style={{ fontSize: 12, padding: '2px 8px', background: 'none', border: '1px solid #3a3a3a', borderRadius: 4, color: '#888', cursor: 'pointer' }}
            onClick={closeSearch} title="关闭 (Esc)">✕</button>
        </div>
      )}

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
