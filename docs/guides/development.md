# 开发指南

本指南说明如何在本地构建、运行和验证 PosixLoom Runtime。所有命令均从仓库根目录执行。

## 环境要求

- Windows 10/11 x64。
- Node.js 22+ 与 npm。
- Rust stable（包含 Cargo 和 rustfmt）。
- 运行 Shell 集成测试时，需要可用的 MSYS2 Bash 或 Git Bash。

Windows Shell 同时要求已构建的 Native Host（`npm run build:host`）。它通过
Job Object 管理 MSYS fork/exec 后的后代，并协调同一安装的共享挂载；不能使用
Node/taskkill 回退来提供这些保证。只执行纯模块单元测试仍不要求安装 Bash。

发布包会自带固定版本的 Node、MSYS2、MinGit 和 ripgrep；本地开发可以使用已安装工具，发布流程不会依赖这些回退。

## 初始化与构建

```powershell
npm install

# 只编译 TypeScript
npm run build

# 只构建 Rust Native Host
npm run build:host

# 同时构建两部分
npm run build:all
```

TypeScript 的 JavaScript 与 `.d.ts` 声明输出写入 `dist/`，Rust 输出写入 `native/posixloom-host/target/`。二者都已被 Git 忽略。

## 运行 CLI

兼容 CLI 名称仍为 `posixloom`：

```powershell
# 运行时诊断
npm run doctor

# 精确 argv 模式
npm run posixloom -- exec -- rg --version
npm run posixloom -- exec -- node -p 'process.platform'

# 覆盖虚拟工作目录
npm run posixloom -- exec --cwd /workspace -- rg TODO src

# 预览完整计划，不创建目标进程
npm run posixloom -- explain --json exec -- rg TODO /workspace/src

# 只读部署诊断
npm run posixloom -- config validate
npm run posixloom -- runtime info
npm run posixloom -- trace list --limit 50
```

直接运行编译产物也可以跳过 npm 包装：

```powershell
node dist/src/cli/main.js runtime doctor
node dist/src/cli/main.js exec -- git --version
```

Native Host launcher 构建成功后可这样调用：

```powershell
native\posixloom-host\target\debug\posixloom.exe runtime doctor
```

便携包中的顶层 `posixloom.exe` 使用相同的公开命令语法，所有命令均经过 launcher 完整性校验。既有 `posixloom.exe launch ...` 调用继续兼容。

## Shell 与会话

开发模式下可通过 `POSIXLOOM_BASH` 指定 Bash。发布包会自动选择 Runtime 内置 Bash。

```powershell
$env:POSIXLOOM_BASH = 'C:\Program Files\Git\usr\bin\bash.exe'

npm run posixloom -- shell -c 'printf "%s\n" "hello" | grep hello'

# 避免 PowerShell 对嵌套引号进行二次处理
'printf "%s\n" "hello from stdin"' | npm run posixloom -- shell --stdin

# 同一 Session 中保留 cwd 和 exported env
@'
cd /workspace/tests
export POSIXLOOM_DEMO=yes
printf '%s\n' "$POSIXLOOM_DEMO"
'@ | npm run posixloom -- repl

# ConPTY 交互模式：保留提示、颜色、按键和终端尺寸
npm run posixloom -- shell --pty -c 'read -p "name: " name; printf "hello %s\n" "$name"'
```

## 测试与质量门禁

```powershell
# 不生成文件的类型检查
npm run typecheck

# 源文件行尾与末尾换行检查
npm run format:check

# TypeScript/Node 测试；会先构建 TS 与 Native Host
npm test

# 快速模块测试 / 进程与打包集成测试
npm run test:unit
npm run test:integration
npm run test:coverage

# 将 SDK 打包并在仓库外离线安装，检查声明、公开导入与完整执行生命周期
npm run test:sdk

# 冷/热启动和有界输出收集的性能门禁
npm run benchmark:check

# Rust 单元测试
cargo test --locked --manifest-path native/posixloom-host/Cargo.toml

# 提交前完整门禁
npm run verify
```

`npm run verify` 会检查源码格式、Rust 格式和 Clippy（警告视为错误），构建 release Native Host，并运行 Node 与 Rust 测试。Windows CI 覆盖 Node 22/24，另外执行性能预算检查；基线与采样方法见[性能指南](performance.md)。

## 控制面调试

```powershell
npm run build:all
node dist/src/cli/main.js serve --stdio
# 已构建后的等价入口；--silent 屏蔽 npm 的启动提示
npm run --silent serve:stdio
```

该接口使用长度前缀 JSON 帧，不是逐行 JSON。机器客户端优先直接启动 `node dist/src/cli/main.js serve --stdio` 或便携包的 `posixloom.exe serve --stdio`；构建应在建立协议通道前完成，stdout 必须只包含帧。请求格式见 [Control protocol v1](../protocols/control-v1.md)。Shell 命令的状态提交格式见 [StateReport v1](../protocols/state-report-v1.md)。

## 嵌入 SDK

执行 `npm run build` 后，`npm pack` 生成包含公开 ESM 入口、TypeScript 声明和静态资源的本地安装包。宿主安装 tarball 后，可直接从 `posixloom-runtime` 导入。包保持 `private: true`，不会因此发布到公共仓库。

`RuntimeManager.create(runRoot)` 的参数是已有 PosixLoom 便携包或开发仓库根目录；SDK 安装包不附带第三方 Runtime 二进制。宿主工作区默认为进程 cwd，数据目录可通过 `POSIXLOOM_DATA_ROOT` 指定。示例位于 [`examples/embedded.mjs`](../../examples/embedded.mjs)，涵盖会话、精确 argv、二进制输出和 `finally` 中的 `runtime.close()`。

`npm run test:sdk` 从实际 tarball 创建临时离线消费项目，使用独立模块解析检查公共类型，再执行示例。它不从网络安装依赖。

## 常见问题

### doctor 找不到 Bash

设置 `POSIXLOOM_BASH` 为本机 `bash.exe` 的绝对路径，或先按[发布与更新指南](release.md)物化完整组件目录。

### 修改后仍运行旧代码

`node dist/src/cli/main.js` 运行的是编译产物。先执行 `npm run build`，或使用会自动构建的 `npm run posixloom -- ...`。

### 哪些目录可以清理

`dist/`、`artifacts/`、`data/`、`node_modules/` 和 `native/posixloom-host/target/` 都是可再生成内容。`runtime/versions/runtime-dev/manifest.json` 与 `runtime/current` 是已提交的开发运行时元数据，不应当作普通缓存删除。
