# SSH Manager

跨平台 SSH 客户端桌面应用，基于 Electron + React 构建，提供多标签终端管理体验。

## 功能特性

- 多标签 SSH 会话管理
- 侧边栏快速连接已保存的主机
- 内置终端模拟器（xterm.js）
- 支持 ZMODEM 文件传输（sz/rz）
- 配置持久化存储
- 跨平台支持：macOS、Windows、Linux

## 技术栈

- **前端**：React 18 + Vite
- **桌面框架**：Electron 28
- **终端**：xterm.js + node-pty
- **构建打包**：electron-builder

## 开发环境要求

- Node.js >= 18
- npm >= 9
- macOS 需要 Xcode Command Line Tools（用于编译 node-pty）

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

同时启动 Vite 开发服务器（端口 5173）和 Electron 窗口。

## 构建打包

```bash
# 当前平台
npm run build

# macOS（生成 dmg + zip，支持 arm64 / x64）
npm run build:mac

# Windows（生成 nsis 安装包 + 便携版）
npm run build:win
```

构建产物输出到 `release/` 目录。

## 项目结构

```
ssh-manager/
├── electron/          # 主进程
│   ├── main.js        # Electron 主进程入口
│   └── preload.js     # 预加载脚本（contextBridge）
├── src/               # 渲染进程（React）
│   ├── components/    # UI 组件
│   │   ├── MenuBar.jsx
│   │   ├── Sidebar.jsx
│   │   ├── TabBar.jsx
│   │   ├── TerminalPane.jsx
│   │   ├── SessionDialog.jsx
│   │   └── CommandBar.jsx
│   ├── App.jsx
│   ├── main.jsx
│   └── styles/
├── assets/            # 图标等构建资源
├── scripts/           # 构建脚本（afterPack 等）
└── dist/              # Vite 构建输出（不提交）
```

## License

MIT
