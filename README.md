# PosixLoom Runtime

PosixLoom Runtime 是面向 Windows 自动化与 AI Harness 的便携式 POSIX 命令运行时。它把 Windows 原生工具、MSYS2 Bash 语义和虚拟 POSIX 路径组合成统一、可诊断、可更新的执行环境。

> **统一命名空间**：CLI 与可执行文件使用 `posixloom`，环境变量使用 `POSIXLOOM_*`，虚拟运行时路径使用 `/posixloom`，Rust Native Host 位于 `native/posixloom-host/`。项目不提供其他历史前缀或别名。

## 项目定位

PosixLoom 不是 Linux Kernel、系统调用模拟器或完整虚拟机。它根据命令语义选择执行路径：

```text
CLI / Harness
    │
    ▼
TypeScript 控制面（分类、路径、环境、会话、策略）
    │
    ├── 简单且已验证的命令 ──→ Windows Native Fast Path
    │
    └── 脚本、管道与 Shell 语义 ──→ Minimal MSYS2 Bash
                                      │
                                      ▼
                          Windows 文件系统与进程模型
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
```

启动 Harness 控制面：

```powershell
npm run posixloom -- serve --stdio
```

协议使用长度前缀 JSON 帧，详见 [control protocol v1](docs/protocols/control-v1.md)。

## 仓库结构

| 路径 | 用途 |
|---|---|
| `src/cli/` | `posixloom` CLI 与命令分发 |
| `src/core/` | 分类、路径、环境、会话、执行、策略、更新等核心逻辑 |
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
- [发布与更新指南](docs/guides/release.md)：组件供应链、Runtime 组装、签名和验证。
- [控制协议 v1](docs/protocols/control-v1.md) 与 [StateReport v1](docs/protocols/state-report-v1.md)。

## 当前边界

项目目前处于 `0.1.0` 开发阶段，目标平台为 Windows 10/11 x64。默认策略提供的是防误操作 Guardrail，不是针对恶意本地代码的 OS 级安全沙箱。发布前应执行完整门禁：

```powershell
npm run verify
```
