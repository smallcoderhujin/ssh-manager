# SSH Manager

跨平台 SSH 客户端桌面应用，基于 Electron + React 构建，提供多标签终端管理体验。

## 功能特性

- **多标签会话管理** — 支持新建、关闭、拖拽排序、复制标签页，⌘T / ⌘W / ⌘1-9 快捷键切换
- **左右 / 上下分屏** — 同一标签页内多终端并排显示
- **侧边栏会话库** — 按分组折叠展示（默认全部折叠），组内会话字母排序，支持搜索
- **快速连接** — 直接输入 `user@host` 或 `user@host:port` 一键连接
- **断线重连** — 连接断开后按 Enter 键自动重连，SSH ConnectTimeout 10 秒
- **底部快捷命令栏** — 保存常用命令，右键快捷菜单支持执行 / 编辑 / 删除
- **会话持久化** — 每次标签变更实时保存，下次启动自动恢复上次打开的会话列表
- **时间戳行号侧边栏** — 每行显示写入时间戳，辅助日志分析
- **ZMODEM 文件传输** — 内置 sz/rz 进度显示，支持在 Finder 中打开下载文件
- **WebGL 渲染** — 使用 xterm-addon-webgl 避免长行换行时出现空白行
- **字体大小调节** — ⌘+ / ⌘- / ⌘0，设置持久化
- **输入法自动切换** — 应用获得焦点时自动切回英文输入（macOS 使用 Carbon API，无需辅助功能权限）
- **跨平台** — macOS arm64 / x64、Windows x64

## 技术栈

| 层 | 技术 |
|---|---|
| 前端框架 | React 18 + Vite 5 |
| 桌面框架 | Electron 28 |
| 终端渲染 | xterm.js 5.3 + xterm-addon-webgl |
| PTY | node-pty 1.1 |
| 数据持久化 | electron-store 8 |
| 文件传输 | zmodem.js |
| 打包 | electron-builder 24 |

## 开发环境要求

- Node.js ≥ 18
- npm ≥ 9
- macOS：Xcode Command Line Tools（编译 node-pty 原生模块）
- Windows：Visual Studio Build Tools + Python（编译 node-pty）

## 安装依赖

```bash
npm install
```

macOS 还需要重新编译原生模块：

```bash
npm run rebuild:mac
```

## 开发运行

```bash
npm run dev
```

同时启动 Vite 开发服务器（端口 5173）和 Electron 窗口，支持热更新。

## 构建打包

```bash
# macOS（生成 dmg + zip，arm64 和 x64 各一份）
npm run build:mac

# Windows（生成 nsis 安装包 + 便携版）
npm run build:win

# 当前平台
npm run build
```

构建产物输出到 `release/` 目录。

### macOS 打包说明

无需 Apple Developer 账号，使用 ad-hoc 签名（`codesign --sign -`）：

- `afterPack` 脚本自动修复 `spawn-helper` 执行权限（electron-builder 拷贝后权限为 644，会导致 `posix_spawnp failed`）
- 同步签名 `switch-ime` 辅助二进制（用于输入法切换）
- 不开启 `hardenedRuntime`，避免影响 node-pty 的 PTY 系统调用

## 项目结构

```
ssh-manager/
├── electron/
│   ├── main.js            # 主进程：PTY 管理、IPC、窗口创建
│   └── preload.js         # contextBridge 暴露 electronAPI
├── src/
│   ├── App.jsx            # 根组件：标签状态、会话持久化
│   ├── components/
│   │   ├── TabBar.jsx         # 标签栏（拖拽排序、快捷键）
│   │   ├── TerminalPane.jsx   # 终端面板（xterm.js + WebGL + PTY）
│   │   ├── Sidebar.jsx        # 右侧会话列表
│   │   ├── CommandBar.jsx     # 底部快捷命令栏
│   │   └── SessionDialog.jsx  # 新建 / 编辑会话对话框
│   └── styles/
├── assets/
│   └── switch-ime         # macOS 输入法切换 Universal Binary（Swift 编译）
├── scripts/
│   └── afterPack.js       # electron-builder 打包后钩子（权限修复 + ad-hoc 签名）
└── dist/                  # Vite 构建输出（不提交）
```

## 已知限制

- macOS 输入法自动切换依赖 Carbon `TISSelectInputSource`，在沙盒环境下不可用（当前为非沙盒打包，无影响）
- Windows 输入法切换通过 IMM32 API 实现，部分基于 TSF 框架的第三方输入法（如搜狗）可能无法完全生效

## License

MIT
