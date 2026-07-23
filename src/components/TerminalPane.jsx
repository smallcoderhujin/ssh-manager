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
  const [networkOffline, setNetworkOffline] = useState(!navigator.onLine);
  const [fontSize, setFontSize] = useState(14);
  const fontSizeRef = useRef(14);
  const [zmodem, setZmodem] = useState(null); // null | { direction, name, received, total, done, savedPath }

  // Gutter state — kept in refs to avoid excessive re-renders, flushed to state on scroll/data
  const lineTimestampsRef = useRef(new Map()); // bufferLine -> "HH:MM:SS"
  const trackedLinesRef = useRef(0);           // how many lines we've assigned timestamps
  const [gutterViewport, setGutterViewport] = useState({ y: 0, rows: 24, total: 0, cellHeight: fontSize * LINE_HEIGHT });
  const cellHeightRef = useRef(fontSize * LINE_HEIGHT);

  const webglAddonRef = useRef(null); // only the active tab holds a WebGL context
  const termRowRef = useRef(null);    // gutter+terminal row div, positioning parent for dropdown
  const searchAddonRef = useRef(null);
  const inputBufferRef = useRef('');   // tracks current input line for history
  const inputModifiedByShellRef = useRef(false); // TAB / arrow modified the line
  const pendingCmdRef = useRef(null);  // command entered but not yet confirmed success/fail
  const pendingOutputRef = useRef(''); // PTY output accumulated since last Enter
  const hostKeyErrRef = useRef(false); // "REMOTE HOST IDENTIFICATION HAS CHANGED" seen in output
  // Watch PTY output for the ssh known_hosts mismatch error so we can offer
  // a one-key fix (ssh-keygen -R) instead of making the user do it manually.
  const detectHostKeyError = (data) => {
    try {
      const text = typeof data === 'string' ? data : new TextDecoder().decode(data);
      if (/REMOTE HOST IDENTIFICATION HAS CHANGED|Host key verification failed/.test(text)) {
        hostKeyErrRef.current = true;
      }
    } catch (_) {}
  };
  const [suggestions, setSuggestions] = useState([]); // autocomplete list
  const [suggestionIdx, setSuggestionIdx] = useState(-1); // selected suggestion index
  const suggestionsRef = useRef([]);    // mirror of suggestions for use inside onData closure
  const suggestionsIdxRef = useRef(-1); // mirror of suggestionIdx for use inside onData closure
  const [cursorRowsBelow, setCursorRowsBelow] = useState(24); // rows below cursor in viewport
  const [searchVisible, setSearchVisible] = useState(false);
  const searchVisibleRef = useRef(false);
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
  searchVisibleRef.current = searchVisible;

  const updateStatus = useCallback((s) => {
    statusRef.current = s;
    setStatus(s);
    onStatusChange?.(s);
  }, [onStatusChange]);

  // ── Network status ───────────────────────────────────────────────────────
  useEffect(() => {
    const onOffline = () => setNetworkOffline(true);
    const onOnline  = () => setNetworkOffline(false);
    window.addEventListener('offline', onOffline);
    window.addEventListener('online',  onOnline);
    return () => {
      window.removeEventListener('offline', onOffline);
      window.removeEventListener('online',  onOnline);
    };
  }, []);

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
      else if ((e.key === 'c' || e.key === 'C') && e.metaKey && !e.ctrlKey) {
        // Cmd+C: copy selection (don't interfere with Ctrl+C → PTY)
        if (!isActiveRef.current) return;
        const sel = termRef.current?.getSelection();
        if (sel) {
          e.preventDefault();
          e.stopPropagation();
          window.electronAPI?.clipboard.writeText(sel);
          termRef.current?.clearSelection();
        }
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
      cursorStyle: 'block',  // block is more visible than bar
      cursorWidth: 2,
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
    searchAddonRef.current = searchAddon;
    termRef.current = term;
    fitAddonRef.current = fitAddon;
    // NOTE: term.open() is deferred to the startObserver below. Restored
    // background tabs mount inside display:none containers (0×0); opening
    // xterm there makes the renderer measure bogus cell metrics, and the
    // terminal ends up as a tiny region stuck in the top-left corner that
    // no later fit() can repair.

    // Load WebGL once when the terminal opens; CSS display:none on inactive
    // tab containers means the context is idle but alive — no dispose/reload
    // thrash needed on tab switches.
    const loadWebgl = () => {
      try {
        const webgl = new WebglAddon();
        webgl.onContextLoss(() => {
          try { webgl.dispose(); } catch (_) {}
          webglAddonRef.current = null;
        });
        term.loadAddon(webgl);
        webglAddonRef.current = webgl;
      } catch (_) {}
    };

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

    // Track rows below cursor so suggestion dropdown can be placed above the input line
    const updateCursorRows = () => {
      const buf = term.buffer.active;
      setCursorRowsBelow(term.rows - 1 - buf.cursorY);
    };
    term.onCursorMove(updateCursorRows);
    term.onResize(updateCursorRows);

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

    // Select → copy (skip while search bar is open to avoid overwriting clipboard with match highlights)
    term.onSelectionChange(() => {
      if (searchVisibleRef.current) return;
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
    // setupImeHint is invoked after term.open() in the startObserver below —
    // the textarea doesn't exist until the terminal is opened.

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
      // NOTE: the CommandBar send-fn is registered in a dedicated mount effect
      // (see below), NOT here — this async path only runs when the tab first
      // becomes visible, and restored tabs could miss the registration.

      // Match shell-level errors only (not application log content)
      // These patterns appear at the START of a line in shell error output
      // Match shell-level errors (not application log content).
      // Must cover: bash/zsh "command not found", Ubuntu "Command 'x' not found",
      // permission denied, and other shell errors. Use /i for case-insensitive match.
      const FAIL_RE = /^[^\n]*(?:command not found|not found[,\s]|: No such file or directory|: Permission denied|: invalid option|: illegal option|: syntax error|: cannot access|: Operation not permitted)/im;
      // Strip ANSI escape codes from PTY output for text analysis
      const stripAnsi = (s) => s.replace(/\x1b\[[0-9;]*[mABCDHfJKSTu]/g, '').replace(/\x1b\][^\x07]*\x07/g, '').replace(/\x1b[()][AB012]/g, '');

      dataCleanupRef.current = window.electronAPI.terminal.onData(({ id, data }) => {
        if (id === result.id) {
          // data is Uint8Array (Buffer serialized by Electron IPC) or string
          term.write(data instanceof Uint8Array ? data : data, trackTimestamps);
          // Notify parent when new output arrives in a background tab
          if (!isActiveRef.current) onActivityRef.current?.();
          detectHostKeyError(data);

          // Pending command success/failure detection
          if (pendingCmdRef.current) {
            const text = typeof data === 'string' ? data : new TextDecoder().decode(data);
            const clean = stripAnsi(text);
            pendingOutputRef.current += clean;
            // Cap buffer to last 2000 chars to avoid false positives from log output
            if (pendingOutputRef.current.length > 2000) {
              pendingOutputRef.current = pendingOutputRef.current.slice(-2000);
            }
            // Detect a new shell prompt — indicates command has finished
            // Match lines ending with common prompt suffixes ($ # % >) after stripping colors
            const lines = pendingOutputRef.current.split(/\r?\n/);
            const lastLine = lines[lines.length - 1].trimEnd();
            if (pendingOutputRef.current.includes('\n') && /[$#%>]\s*$/.test(lastLine)) {
              const failed = FAIL_RE.test(pendingOutputRef.current);
              if (!failed) {
                window.electronAPI.history.add(pendingCmdRef.current);
              }
              pendingCmdRef.current = null;
              pendingOutputRef.current = '';
            }
          }
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
          if (hostKeyErrRef.current && (sessionConfig || quickConnect)) {
            term.writeln('\x1b[33m[检测到远程主机密钥已变更（known_hosts 冲突）]\x1b[0m');
            term.writeln('\x1b[2m[按 Y 清除本机旧密钥并重连；按 Enter 直接重连]\x1b[0m');
          } else if (sessionConfig || quickConnect) {
            term.writeln('\x1b[2m[Press Enter to reconnect]\x1b[0m');
          }
        }
      });

      term.onData((data) => {
        if (isComposingRef.current) return;
        // When suggestion dropdown is open, handle special keys
        if (suggestionsRef.current.length > 0) {
          const isArrow = data === '\x1b[A' || data === '\x1b[B';
          if (isArrow) return; // keydown handler already navigated the list; don't send to PTY
          if (data === '\r' && suggestionsIdxRef.current >= 0) { setSuggestions([]); return; }
          if (data === '\r') setSuggestions([]);
        }
        if (statusRef.current === 'disconnected') {
          if ((data === 'y' || data === 'Y') && hostKeyErrRef.current && reconnectRef.current) {
            hostKeyErrRef.current = false;
            const qc = (quickConnect || '').trim().split(/\s+/)[0];
            const host = sessionConfig?.host || (qc.includes('@') ? qc.split('@').pop() : qc);
            const port = sessionConfig?.port;
            term.writeln(`\x1b[36m[正在清除 ${host} 的旧主机密钥…]\x1b[0m`);
            window.electronAPI.ssh?.removeHostKey(host, port).then((ok) => {
              if (ok) {
                term.writeln('\x1b[32m[旧密钥已清除，正在重连…]\x1b[0m');
                reconnectRef.current?.();
              } else {
                term.writeln(`\x1b[31m[清除失败，请手动执行: ssh-keygen -R ${host}]\x1b[0m`);
              }
            });
          } else if (data === '\r' && reconnectRef.current) {
            hostKeyErrRef.current = false;
            reconnectRef.current();
          }
        } else if (terminalIdRef.current !== null) {
          window.electronAPI.terminal.write(terminalIdRef.current, data);
          if (data === '\r') {
            term.scrollToBottom();
            // Capture the keystroke tracker NOW — it's cleared synchronously
            // below, and it's ahead of the xterm buffer by the SSH echo delay.
            const typed = inputBufferRef.current.trim();
            const shellModified = inputModifiedByShellRef.current;
            inputModifiedByShellRef.current = false;

            // Wait briefly for the remote echo, then read the buffer and
            // reconcile with the tracker (same strategy as updateSuggestions):
            // prefix relation → take the longer; divergence → trust the buffer.
            const delayMs = shellModified ? 30 : 0;
            setTimeout(() => {
              let bufCmd = '';
              try {
                const buf = term.buffer.active;
                // Walk back from cursorY to find start of the logical (possibly
                // wrapped) line.
                let endY = buf.cursorY;
                let startY = endY;
                while (startY > 0 && buf.getLine(buf.baseY + startY)?.isWrapped) {
                  startY--;
                }
                let raw = '';
                for (let y = startY; y <= endY; y++) {
                  const line = buf.getLine(buf.baseY + y);
                  if (!line) break;
                  raw += line.translateToString(y === endY);
                }
                raw = raw.trimEnd();
                const m = raw.match(/[#$%>]\s+(.+)$/);
                bufCmd = (m ? m[1] : '').trim();
              } catch (_) {}

              let cmd;
              if (bufCmd.startsWith(typed) || typed.startsWith(bufCmd)) {
                cmd = typed.length >= bufCmd.length ? typed : bufCmd;
              } else {
                cmd = bufCmd || typed;
              }

              if (cmd) {
                pendingCmdRef.current = { cmd, host: sessionConfig?.host || quickConnect || '' };
                pendingOutputRef.current = '';
              }
            }, delayMs);

            // Clear input tracking immediately
            inputBufferRef.current = '';
            setSuggestions([]);
          } else if (data === '\x7f') {
            // Backspace
            inputBufferRef.current = inputBufferRef.current.slice(0, -1);
            updateSuggestions(inputBufferRef.current);
          } else if (data === '\x03' || data === '\x04' || data === '\x15') {
            // Ctrl+C/D: save pending command immediately (user ran it intentionally)
            if ((data === '\x03' || data === '\x04') && pendingCmdRef.current) {
              window.electronAPI.history.add(pendingCmdRef.current);
              pendingCmdRef.current = null;
              pendingOutputRef.current = '';
            }
            inputBufferRef.current = '';
            inputModifiedByShellRef.current = false;
            setSuggestions([]);
          } else if (data === '\x09') {
            // TAB — shell will complete; xterm buffer needed on Enter
            inputModifiedByShellRef.current = true;
            setSuggestions([]);
          } else if (data === '\x1b[A' || data === '\x1b[B' || data === '\x1b[C' || data === '\x1b[D') {
            // Arrow keys — shell history recall or cursor move; xterm buffer on Enter
            inputModifiedByShellRef.current = true;
            setSuggestions([]);
          } else if (data.length === 1 && data.charCodeAt(0) >= 32) {
            inputBufferRef.current += data;
            updateSuggestions(inputBufferRef.current);
          } else if (data.length > 1 && !data.startsWith('\x1b')) {
            // Paste — append printable chars to buffer (exclude escape sequences)
            const printable = [...data].filter(c => c.charCodeAt(0) >= 32).join('');
            if (printable) { inputBufferRef.current += printable; updateSuggestions(inputBufferRef.current); }
          } else {
            // Other escape sequences — pass through
            setSuggestions([]);
          }
        }
      });

      term.onResize(({ cols, rows }) => {
        if (terminalIdRef.current !== null)
          window.electronAPI.terminal.resize(terminalIdRef.current, cols, rows);
      });
    };

    // Wait until the container has a real layout size before opening xterm
    // and creating the PTY. Restored background tabs sit in display:none
    // containers (0×0) — opening xterm there makes the renderer measure bogus
    // cell metrics that no later fit() can repair, and the PTY would be told
    // wrong dimensions. The observer fires once the tab first becomes visible.
    let started = false;
    const startObserver = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width ?? 0;
      const h = entries[0]?.contentRect.height ?? 0;
      if (w > 0 && h > 0 && !started) {
        started = true;
        startObserver.disconnect();
        term.open(containerRef.current);
        loadWebgl();
        setupImeHint();
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

  // Register the CommandBar send-fn once at mount. The fn dereferences
  // terminalIdRef at call time, so registering before the PTY exists is safe
  // — and it can't be skipped by the deferred-open / async-create flow that
  // restored tabs go through.
  useEffect(() => {
    onReady?.((text) => {
      if (terminalIdRef.current !== null && window.electronAPI) {
        window.electronAPI.terminal.write(terminalIdRef.current, text);
        try { termRef.current?.focus(); } catch (_) {}
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Resize observer — handles container size changes (sidebar drag, split pane, etc.)
  useEffect(() => {
    if (!containerRef.current) return;
    const observer = new ResizeObserver((entries) => {
      // Skip when container is hidden (display:none on parent collapses size to 0)
      const w = entries[0]?.contentRect.width ?? 0;
      const h = entries[0]?.contentRect.height ?? 0;
      if (w > 0 && h > 0) {
        try { fitAddonRef.current?.fit(); } catch (_) {}
      }
    });
    observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, []);

  // Window resize handler — catches fullscreen toggle and window drag-resize.
  // Inactive tabs have display:none so ResizeObserver never fires for them;
  // we record that a resize happened and apply fit() the next time the tab
  // becomes active.
  useEffect(() => {
    let pendingResize = false;
    const onWindowResize = () => {
      const el = containerRef.current;
      if (!el) return;
      if (el.clientWidth > 0 && el.clientHeight > 0) {
        // Tab is visible — fit immediately
        try { fitAddonRef.current?.fit(); } catch (_) {}
      } else {
        // Tab is hidden — defer fit() until it becomes active
        pendingResize = true;
      }
    };
    window.addEventListener('resize', onWindowResize);
    return () => window.removeEventListener('resize', onWindowResize);
  }, []);

  useEffect(() => {
    if (isActive && termRef.current) {
      // Use double rAF so the browser paints the display:flex container
      // before focus() is called — single rAF or setTimeout(50) can fire
      // while the element is still being laid out after display:none removal.
      requestAnimationFrame(() => requestAnimationFrame(() => {
        if (searchVisibleRef.current) return; // don't steal focus from search bar
        // try/catch: term.open() is deferred until the tab is first visible,
        // so focus() can race ahead of the textarea's creation.
        try { termRef.current?.focus(); } catch (_) {}
        // Only fit if the container has a real size (not hidden)
        const el = containerRef.current;
        if (el && el.clientWidth > 0 && el.clientHeight > 0) {
          try { fitAddonRef.current?.fit(); } catch (_) {}
        }
      }));
      // Reset lingering terminal modes (DECCKM, mouse tracking, focus tracking)
      // by writing DECSTR directly to the xterm renderer — NOT to the PTY.
      // Sending to the PTY would pass it as input to tail/cat which outputs it verbatim.
      termRef.current?.write('\x1b[!p');
    }
  }, [isActive]);

  // WebGL is loaded once at terminal init (above). No per-tab lifecycle needed.

  // Re-seat textarea focus when the Electron window regains focus so that
  // inputmode="none" takes effect and the Windows IME stays off.
  useEffect(() => {
    const unsub = window.electronAPI?.window?.onFocus?.(() => {
      if (searchVisibleRef.current) return; // keep focus on search bar
      const ta = termRef.current?.textarea;
      if (!ta) return;
      ta.blur();
      requestAnimationFrame(() => ta.focus());
    });
    return () => unsub?.();
  }, []);

  // Keep suggestion refs in sync so onData closure can read them without stale capture
  useEffect(() => { suggestionsRef.current = suggestions; }, [suggestions]);
  useEffect(() => { suggestionsIdxRef.current = suggestionIdx; }, [suggestionIdx]);

  // ── History autocomplete ─────────────────────────────────────────────────
  // IMPORTANT: this is an SSH terminal — the character echo comes from the
  // REMOTE shell over the network, so the xterm buffer lags behind keystrokes
  // by a full round-trip (potentially hundreds of ms). No fixed delay can
  // guarantee the buffer already contains the just-typed character. The
  // keystroke tracker (inputBufferRef) is updated synchronously in onData, so
  // its LAST character is always fresh — use it for the word-boundary check,
  // and reconcile it with the buffer for the actual search text.
  const suggestTimerRef = useRef(null);
  const updateSuggestions = useCallback((input) => {
    clearTimeout(suggestTimerRef.current);
    // Don't show suggestions if search box is open
    if (searchVisibleRef.current) {
      setSuggestions([]);
      return;
    }
    const typed = input || '';
    // Trailing space = word boundary: pause matching until the next character.
    // This check MUST use the synchronous tracker, not the (laggy) buffer.
    if (!typed || typed.endsWith(' ')) {
      setSuggestions([]);
      return;
    }
    suggestTimerRef.current = setTimeout(async () => {
      // Read the current command line from the xterm buffer (authoritative
      // when TAB completion / shell history rewrote the line).
      let bufText = '';
      try {
        const buf = termRef.current?.buffer.active;
        if (buf) {
          let endY = buf.cursorY;
          let startY = endY;
          while (startY > 0 && buf.getLine(buf.baseY + startY)?.isWrapped) {
            startY--;
          }
          let raw = '';
          for (let y = startY; y < endY; y++) {
            const line = buf.getLine(buf.baseY + y);
            if (!line) break;
            raw += line.translateToString(false); // mid-wrap lines are full-width
          }
          // Slice the cursor's line up to cursorX so trailing spaces survive
          // (translateToString's trimRight would strip them).
          const cursorLine = buf.getLine(buf.baseY + endY);
          if (cursorLine) {
            raw += cursorLine.translateToString(false, 0, buf.cursorX);
          }
          const m = raw.match(/[#$%>]\s+(.+)$/);
          bufText = m ? m[1] : '';
        }
      } catch (_) {}

      // Reconcile tracker vs buffer: if one is a prefix of the other they
      // describe the same line at different echo stages — take the longer
      // (fresher) one. If they diverge, the tracker missed keys (IME, shell
      // edits) — trust the buffer.
      let searchInput;
      if (bufText.startsWith(typed) || typed.startsWith(bufText)) {
        searchInput = typed.length >= bufText.length ? typed : bufText;
      } else {
        searchInput = bufText || typed;
      }

      if (!searchInput.trim() || searchInput.length < 2 || searchInput.endsWith(' ')) {
        setSuggestions([]);
        return;
      }
      const results = await window.electronAPI?.history?.search(searchInput, 5);
      setSuggestions(results || []);
      setSuggestionIdx(-1);
    }, 40);
  }, []);

  const applySuggestion = useCallback((cmd) => {
    const id = terminalIdRef.current;
    if (!id) return;
    // Clear current input with Ctrl+U, then type the suggestion
    window.electronAPI.terminal.write(id, '\x15' + cmd);
    inputBufferRef.current = cmd;
    setSuggestions([]);
    termRef.current?.focus();
  }, []);

  // Handle Tab/Esc for autocomplete — must intercept before xterm gets them.
  // Defined AFTER applySuggestion to avoid temporal dead zone.
  useEffect(() => {
    const handler = (e) => {
      if (!isActiveRef.current) return;
      if (searchVisibleRef.current) return;
      if (suggestions.length > 0) {
        if (e.key === 'Enter' && suggestionIdx >= 0) {
          e.preventDefault();
          e.stopPropagation();
          applySuggestion(suggestions[suggestionIdx].cmd);
        } else if (e.key === 'Escape') {
          e.preventDefault();
          setSuggestions([]);
        } else if (e.key === 'ArrowUp') {
          e.preventDefault();
          setSuggestionIdx((i) => (i <= 0 ? suggestions.length - 1 : i - 1));
        } else if (e.key === 'ArrowDown') {
          e.preventDefault();
          setSuggestionIdx((i) => (i >= suggestions.length - 1 ? 0 : i + 1));
        } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
          // Cursor movement — close suggestions, let key pass through to terminal
          setSuggestions([]);
        }
      }
    };
    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, [suggestions, suggestionIdx, applySuggestion]);

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
    // findNext/findPrevious scrolls xterm which may steal focus; take it back.
    requestAnimationFrame(() => searchInputRef.current?.focus());
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
    pendingCmdRef.current = null;
    pendingOutputRef.current = '';
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
    termRef.current.scrollToBottom();

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
        detectHostKeyError(data);
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
        if (hostKeyErrRef.current && (sessionConfig || quickConnect)) {
          termRef.current?.writeln('\x1b[33m[检测到远程主机密钥已变更（known_hosts 冲突）]\x1b[0m');
          termRef.current?.writeln('\x1b[2m[按 Y 清除本机旧密钥并重连；按 Enter 直接重连]\x1b[0m');
        } else if (sessionConfig || quickConnect) {
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

      {/* Network offline warning */}
      {networkOffline && status === 'connected' && (
        <div style={{
          flexShrink: 0, display: 'flex', alignItems: 'center', gap: 8,
          padding: '5px 12px', background: 'rgba(255,189,46,0.12)',
          borderBottom: '1px solid rgba(255,189,46,0.35)',
        }}>
          <span style={{ fontSize: 12, color: '#ffbd2e' }}>
            ⚠ 网络已断开，会话将在约 6 秒后自动检测并提示重连
          </span>
        </div>
      )}


      {/* Gutter + Terminal row */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'row', overflow: 'hidden', position: 'relative' }} ref={termRowRef}>

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
        <div style={{ flex: 1, overflow: 'visible', position: 'relative' }}>
          <div
            ref={containerRef}
            className="terminal-pane"
            style={{ width: '100%', height: '100%' }}
            onClick={() => termRef.current?.focus()}
          />

        </div>

        {/* ── Autocomplete suggestions overlay — anchored to cursor row ── */}
        {suggestions.length > 0 && (() => {
          const term = termRef.current;
          const cellH = cellHeightRef.current;
          const rowsBelow = term ? (term.rows - 1 - term.buffer.active.cursorY) : 0;
          // leave 1 row gap between dropdown bottom and cursor row
          // Sit just above the input row: 1 row for the cursor line itself
          // plus most of a row of breathing space (a full extra row reads as
          // detached; half a row overlaps the glyphs' ascenders).
          const bottomPx = (rowsBelow + 1) * cellH + Math.round(cellH * 0.8);
          return (
            <div
              onMouseDown={(e) => e.preventDefault()}
              onWheel={(e) => {
                // Let scroll events pass through to terminal without scrolling the dropdown itself
                e.preventDefault();
                termRef.current?.scrollLines(e.deltaY > 0 ? 3 : -3);
              }}
              style={{
                position: 'absolute',
                bottom: bottomPx,
                left: GUTTER_WIDTH, right: 0, zIndex: 30,
                background: '#1a1d23', border: '1px solid #2e3440',
                borderRadius: '4px 4px 0 0',
                maxHeight: 160, overflowY: 'auto',
                boxShadow: '0 -4px 16px rgba(0,0,0,0.5)',
                // clip to the terminal area so it never goes above the top
                clipPath: `inset(0 0 0 0)`,
              }}
            >
              {suggestions.map((s, i) => (
                <div
                  key={i}
                  style={{
                    padding: '3px 10px', cursor: 'pointer', fontSize: 12,
                    fontFamily: '"JetBrains Mono", monospace',
                    background: i === suggestionIdx ? '#2a3040' : 'transparent',
                    color: i === suggestionIdx ? '#4a9eff' : '#e8e8e8',
                    whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                    borderBottom: '1px solid #1e2230',
                  }}
                  onMouseEnter={() => setSuggestionIdx(i)}
                  onMouseLeave={() => setSuggestionIdx(-1)}
                  onClick={() => applySuggestion(s.cmd)}
                >
                  {s.cmd}
                </div>
              ))}
            </div>
          );
        })()}

        {/* ── History panel ── */}
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
            onKeyDown={(e) => { e.stopPropagation(); handleSearchKeyDown(e); }}
            onKeyUp={(e) => e.stopPropagation()}
            onKeyPress={(e) => e.stopPropagation()}
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
