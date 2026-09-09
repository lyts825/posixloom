# PosixLoom Runtime

PosixLoom Runtime 是面向 Windows 自动化与 AI Harness 的便携式 POSIX 命令运行时。它把 Windows 原生工具、MSYS2 Bash 语义和虚拟 POSIX 路径组合成统一、可诊断、可更新的执行环境。

> **统一命名空间**：CLI 与可执行文件使用 `posixloom`，环境变量使用 `POSIXLOOM_*`，虚拟运行时路径使用 `/posixloom`，Rust Native Host 位于 `native/posixloom-host/`。项目不提供其他历史前缀或别名。

## 项目定位

PosixLoom 不是 Linux Kernel、系统调用模拟器或完整虚拟机。它根据命令语义选择执行路径：

```text
CLI / Harness
    │
    ▼
插件微内核（依赖、生命周期、扩展点、回滚）
    │
    ├── descriptor / adapter / classifier / resolver / planner / backend 插件
    │       ├── 简单且已验证的命令 ──→ Windows Native Fast Path
    │       └── 脚本、管道与 Shell 语义 ──→ Minimal MSYS2 Bash
    │
    └── 不可替换安全根：Runtime 完整性、策略、会话 CAS、StateReport 提交
```

核心能力：

- 将 `/workspace`、`/home`、`/tmp`、`/cache` 等虚拟路径映射到真实 Windows 路径。
- 为 `git`、`rg`、`node` 等高频工具提供精确 argv 的 Native Fast Path。
- 通过 one-shot Bash 执行管道、重定向、变量展开与脚本。
- 在同一 Session 中保存 cwd 与导出的环境变量，并支持隔离执行。
- 通过 Rust Native Host、Windows Job Object、超时和取消管理进程树。
- 通过控制协议实时转发二进制安全的 stdout/stderr，并对慢 Harness 施加背压。
- 在执行前预览后端选择、参数翻译、路径决策与策略档案，不启动目标进程。
- 以不可变 Runtime、组件锁文件、Ed25519 Feed 和事务切换实现可复现更新。
- 提供可独立部署的浏览器 GUI 与带 Bearer 鉴权、CORS 白名单、NDJSON 流输出的远程 HTTP API。
- 提供参数化项目任务、可断线续接的后台任务、按序号读取的持久输出和带哈希的产物归档。
- 支持会话快照保存/恢复/分叉、GUI 多会话与执行历史、浏览器 ConPTY 交互终端和脱敏排障报告。
- 提供声明式插件市场；插件安装只落盘经过校验的命令清单，不加载或执行第三方 JavaScript。
- 以内置与自定义能力共用的 `RuntimePlugin` 协议组合命令流水线，支持依赖排序、优先级、事务激活和逆序清理。

## 快速开始

开发环境需要 Windows 10/11 x64、Node.js 22+、npm 和 Rust stable。

```powershell
npm install
npm run build:all
npm test
```

常用命令：

```powershell
# 诊断开发运行时
npm run doctor

# 精确 argv 的 Native Fast Path
npm run posixloom -- exec -- rg --version
npm run posixloom -- exec -- git --version

# 只生成并检查执行计划，不启动命令
npm run posixloom -- explain --json exec -- rg TODO /workspace/src
npm run posixloom -- exec --dry-run --json -- rg TODO /workspace/src

# Shell 路径：开发环境需指定 MSYS2 Bash 或 Git Bash
$env:POSIXLOOM_BASH = 'C:\Program Files\Git\usr\bin\bash.exe'
npm run posixloom -- shell -c 'printf "%s\n" "hello" | grep hello'

# PowerShell 中的复杂脚本建议通过 stdin 传递
'printf "%s\n" "hello from stdin"' | npm run posixloom -- shell --stdin

# Windows ConPTY 交互模式（透传按键、终端尺寸、ANSI 颜色）
npm run posixloom -- shell --pty -c 'read -p "name: " name; printf "hello %s\n" "$name"'

# 配置、运行时与 trace 诊断
npm run posixloom -- config validate
npm run posixloom -- runtime info
npm run posixloom -- trace list --limit 50
```

启动 Harness 控制面：

```powershell
npm run build:all
node dist/src/cli/main.js serve --stdio
```

构建完成后也可用 `npm run --silent serve:stdio`。Harness 启动子进程时应直接运行 Node 入口，或便携包中的 `posixloom.exe serve --stdio`，确保 stdout 从第一字节开始都是协议帧。协议使用长度前缀 JSON 帧，详见 [control protocol v1](docs/protocols/control-v1.md)。

## 嵌入 Node.js 宿主

构建会生成 ESM 入口和 TypeScript 声明；包保持私有，可通过本地 tarball 接入：

```powershell
npm run build
npm pack
# 在宿主项目中安装上一步生成的 tarball
npm install C:\path\to\posixloom-runtime-0.1.0.tgz
```

宿主可使用 `import { RuntimeManager, PosixLoomService } from "posixloom-runtime"`。SDK 调度已有 Runtime，第三方工具和 Native Host 由便携包或开发仓库提供。完整生命周期示例见 [embedded.mjs](examples/embedded.mjs)，运行时传入该 Runtime 的根目录：

```powershell
node node_modules/posixloom-runtime/examples/embedded.mjs C:\path\to\posixloom
```

执行结束后应 `await runtime.close()` 释放观察器、插件和日志资源。`npm run test:sdk` 会在仓库外创建离线消费项目，检查实际 tarball、类型声明和命令执行。

启动本地 GUI（默认分别监听 GUI `127.0.0.1:7330` 与 API `127.0.0.1:7331`）：

```powershell
npm run gui
```

GUI 与 API 是两个独立服务。也可以让 GUI 连接已有远程 API，或只启动 HTTP API：

```powershell
npm run posixloom -- gui --api-url https://posixloom.example.com

$env:POSIXLOOM_HTTP_TOKEN = 'replace-with-at-least-16-bytes'
npm run posixloom -- serve --http --host 0.0.0.0 --port 7331 --cors-origin https://console.example.com
```

浏览及安装声明式插件：

```powershell
npm run posixloom -- plugin search workspace
npm run posixloom -- plugin install workspace-inspector
npm run posixloom -- plugin run workspace-inspector git-status
```

## 仓库结构

| 路径 | 用途 |
|---|---|
| `src/cli/` | `posixloom` CLI 与命令分发 |
| `src/core/` | 分类、路径、环境、会话、执行、策略、更新等核心逻辑 |
| `src/http/` | 独立 HTTP/JSON 适配器与通用扩展端口（不引用 GUI/插件实现） |
| `src/gui/` | 独立静态 GUI 服务与浏览器资源（只接收 API URL） |
| `src/plugins/` | 插件微内核、执行扩展点、第一方能力插件，以及数据型市场插件 |
| `src/composition/` | 显式的可选跨组件适配器；隔离组合知识 |
| `native/posixloom-host/` | Rust Native Host 与 Windows Job Object 集成 |
| `config/` | 默认运行时配置 |
| `runtime/` | 开发 Runtime 指针与快照元数据 |
| `packaging/` | 组件锁定、Runtime 组装、签名发布与验证 |
| `scripts/` | 格式检查、组件同步、密钥与更新 Feed 工具 |
| `tests/` | Node 测试与跨模块集成验证 |
| `docs/` | 开发、发布指南与对外协议 |

`dist/`、`artifacts/`、`data/`、`node_modules/` 和 `native/posixloom-host/target/` 都是本地生成目录，不属于源码。

## 文档导航

- [文档中心](docs/README.md)：指南与协议入口。
- [开发指南](docs/guides/development.md)：环境准备、常用命令、测试与故障排查。
- [配置与诊断](docs/guides/configuration.md)：有效配置、运行时摘要与 trace 查询。
- [GUI 与远程服务](docs/guides/gui-http.md)：分离部署、鉴权、CORS 与启动方式。
- [任务工作台](docs/guides/task-workbench.md)：项目任务、后台执行、日志/产物、快照、浏览器终端与排障报告。
- [插件市场](docs/guides/plugins.md)：清单模型、远程目录、安装和运行边界。
- [一切皆插件架构](docs/guides/plugin-architecture.md)：微内核、扩展点、生命周期、示例与信任边界。
- [发布与更新指南](docs/guides/release.md)：组件供应链、Runtime 组装、签名和验证。
- [HTTP API v1](docs/protocols/http-v1.md)、[控制协议 v1](docs/protocols/control-v1.md) 与 [StateReport v1](docs/protocols/state-report-v1.md)。

## 当前边界

Windows Shell 需要已构建的 Native Host。同一 MSYS 安装的 Shell 会跨进程
互斥执行以保护共享挂载，原生命令继续并发；详见[性能与资源边界](docs/guides/performance.md)。

项目目前处于 `0.1.0` 开发阶段，目标平台为 Windows 10/11 x64。活动 Session 在当前服务进程内保存；可显式保存 cwd 与选定环境变量的快照，在重启后恢复到新会话。历史字段 `session.persistAcrossRestart: true` 仍被拒绝。后台任务可在客户端断线后继续，服务关闭会取消任务；归档跨重启保留，意外退出遗留的任务标为 interrupted，不恢复进程或自动重跑。HTTP 服务自身不终止 TLS，跨机器或公网使用时应置于 HTTPS 反向代理之后。市场插件是不会自动加载代码的声明式命令包；进程内 `RuntimePlugin` 只能由宿主显式注入，必须视为与宿主等权的可信代码。默认策略提供的是防误操作 Guardrail，不是针对恶意本地代码的 OS 级安全沙箱。发布前应执行完整门禁：

```powershell
npm run verify
```
