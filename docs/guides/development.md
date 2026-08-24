# 开发指南

本指南说明如何在本地构建、运行和验证 PosixLoom Runtime。所有命令均从仓库根目录执行。

## 环境要求

- Windows 10/11 x64。
- Node.js 22+ 与 npm。
- Rust stable（包含 Cargo 和 rustfmt）。
- 运行 Shell 集成测试时，需要可用的 MSYS2 Bash 或 Git Bash。

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

TypeScript 输出写入 `dist/`，Rust 输出写入 `native/posixloom-host/target/`。二者都已被 Git 忽略。

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
native\posixloom-host\target\debug\posixloom.exe launch runtime doctor
```

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

# Rust 单元测试
cargo test --locked --manifest-path native/posixloom-host/Cargo.toml

# 提交前完整门禁
npm run verify
```

`npm run verify` 会检查源码格式、Rust 格式，构建 release Native Host，并运行 Node 与 Rust 测试。

## 控制面调试

```powershell
npm run posixloom -- serve --stdio
```

该接口使用长度前缀 JSON 帧，不是逐行 JSON。请求格式见 [Control protocol v1](../protocols/control-v1.md)。Shell 命令的状态提交格式见 [StateReport v1](../protocols/state-report-v1.md)。

## 常见问题

### doctor 找不到 Bash

设置 `POSIXLOOM_BASH` 为本机 `bash.exe` 的绝对路径，或先按[发布与更新指南](release.md)物化完整组件目录。

### 修改后仍运行旧代码

`node dist/src/cli/main.js` 运行的是编译产物。先执行 `npm run build`，或使用会自动构建的 `npm run posixloom -- ...`。

### 哪些目录可以清理

`dist/`、`artifacts/`、`data/`、`node_modules/` 和 `native/posixloom-host/target/` 都是可再生成内容。`runtime/versions/runtime-dev/manifest.json` 与 `runtime/current` 是已提交的开发运行时元数据，不应当作普通缓存删除。
