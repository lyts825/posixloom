# 发布与更新指南

PosixLoom 的发布单元是完整、不可变的 Runtime。Node、Minimal MSYS2、MinGit 和 ripgrep 可以独立跟踪上游版本，但通过兼容性门禁后仍作为一个整体交付。路径与参数转译、Native Host、控制协议和 shims 属于核心，不进行运行中热替换。

## 组件锁定

`packaging/components.sources.json` 定义受信上游，`packaging/components.lock.json` 记录版本、归档、入口、完整树哈希、文件数和许可证路径。锁文件是当前组件版本的唯一事实来源。

```powershell
# 只检查受信上游是否有新版本，不写文件
npm run components:check

# 按已提交锁文件重建相同组件目录，不查询最新版本
npm run components:sync

# 显式刷新上游并重写锁文件
npm run components:update
```

GitHub API 限流时可设置 `GITHUB_TOKEN`。下载缓存、解压目录和发布物只写入已忽略的 `artifacts/`；第三方二进制不提交到源码仓库。

## 低层 Runtime 组装

```powershell
cargo build --release --locked --manifest-path native/posixloom-host/Cargo.toml
npm run build

powershell -ExecutionPolicy Bypass -File .\packaging\build-runtime.ps1 `
  -Mode release `
  -RuntimeId runtime-1.0.0 `
  -RuntimeSemver 1.0.0 `
  -NodeRoot 'C:\path\to\portable-node' `
  -MsysRoot 'C:\path\to\minimal-msys2' `
  -MinGitRoot 'C:\path\to\mingit' `
  -RipgrepExe 'C:\path\to\rg.exe' `
  -LicensesRoot 'C:\path\to\licenses' `
  -ComponentLock 'C:\path\to\components.lock.json' `
  -SourceDateEpoch 1700000000

powershell -ExecutionPolicy Bypass -File .\packaging\verify-runtime.ps1 `
  -PackageRoot .\artifacts\posixloom-portable-win-x64 `
  -RunCorpus
```

开发包固定使用 `runtime-dev`；发布包必须使用版本化且非 `runtime-dev` 的 Runtime ID。仓库内的输出必须位于 `artifacts/`，且输出目录或 ZIP 不能与组件输入重叠。

> 发布目录固定为 `posixloom-portable-win-x64`，入口固定为 `posixloom.exe`；发布流程不生成其他历史名称的副本。

## 本地签名发布

先生成仅供本地测试的 Ed25519 密钥：

```powershell
npm run keys:generate -- `
  --private .\artifacts\local-signing\environment-private.pem `
  --public .\artifacts\local-signing\environment-public.pem
```

再执行完整发布编排：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\packaging\publish-environment.ps1 `
  -KeyId local-environment-2026 `
  -PrivateKey .\artifacts\local-signing\environment-private.pem
```

该流程会按锁文件物化组件、构建 release Native Host、组装包、执行真实
Node/Bash/Git/rg corpus，并在签名 Feed 生成前强制扫描发布目录、便携包 ZIP 与
Runtime ZIP。`-SkipCorpus` 只跳过兼容性语料，不会跳过 Defender 门禁。密钥工具
使用独占创建，不会覆盖已有私钥；生产私钥必须离线保存且不能提交到 Git。

## Defender 发布门禁

在不签名的组装包上可单独运行同一门禁：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\packaging\verify-defender.ps1 `
  -PackageRoot .\artifacts\posixloom-portable-win-x64 `
  -ArchivePaths .\artifacts\posixloom-portable-win-x64.zip, `
    .\artifacts\runtime-1.0.0-env-1700000000.runtime.zip `
  -RequireClientWindows `
  -ExpectedWindows 11 `
  -ReportPath .\artifacts\defender-win11.json
```

门禁要求 Windows 客户端、已启用的 Defender 服务/杀毒/实时保护，以及不超过
72 小时的签名。它调用系统已有的 `MpCmdRun.exe` 自定义扫描并使用
`-DisableRemediation`，不会关闭保护、添加排除项或自动提交文件。扫描前后逐文件
比较 SHA-256 与清单数量；检测、扫描器错误、超时、文件变化或状态变化都会失败。
报告与扫描日志必须写在不可变包之外。

一次通过只说明报告中记录的机器、系统构建、Defender 引擎/签名和那组精确字节
通过，不是长期认证。发现告警时不得通过排除项绕过；应停止签名，保留报告和样本
哈希，定位触发内容并在更新签名后重新组装、复验。

发布前还应手动运行 GitHub Actions 的 `release-defender-client-gate`，把同一个已
暂存包的绝对路径及该包 `SHA256SUMS` 文件的 SHA-256 传给工作流。两台客户端
必须匹配同一个摘要，随后执行完整清单校验、真实 corpus、从公开 EXE 启动的性能
门禁和 Defender 扫描。它只在标记为 `posixloom-clean-win10-x64` 与
`posixloom-clean-win11-x64` 的一次性自托管客户端上执行 Runtime corpus 和
Defender 门禁，不接受不受信任的 pull request 触发。两个作业都通过后，才把对应
字节投入分发；工作流日志和摘要保留各机扫描证据。

## 本地更新与回滚验证

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\packaging\verify-local-update.ps1 `
  -Feed .\artifacts\environment-feed.json `
  -KeyId local-environment-2026 `
  -PublicKey .\artifacts\local-signing\environment-public.pem
```

脚本会使用隔离的 DataRoot 验证签名更新、四个环境组件的真实执行和回滚，不污染常用开发数据。

## 生成远程更新 Feed

```powershell
npm run update:feed -- `
  --runtime-root .\artifacts\posixloom-portable-win-x64\runtime\versions\runtime-1.0.0 `
  --archive .\artifacts\runtime-1.0.0.runtime.zip `
  --archive-url https://updates.example.invalid/runtime-1.0.0.runtime.zip `
  --output .\artifacts\feed.json `
  --key-id release-2026 `
  --private-key .\release-ed25519-private.pem
```

客户端通过 `POSIXLOOM_UPDATE_FEED_URL` 或 DataRoot 配置启用更新。更新写入 DataRoot，不修改只读安装目录；同一核心版本的环境更新由签名数据中的单调 `updateSequence` 排序。

## 完整性与安全边界

- 发布包只携带 `dist/src`，不包含测试产物。
- 发布模式不会从 `PATH` 回退到系统 Git、Node、Bash 或 ripgrep。
- Node、MSYS2、MinGit、ripgrep、Native Host 和 shims 都进入 manifest 入口与树哈希。
- Launcher 在启动 Node 前校验控制面、配置、Node 入口和 `SHA256SUMS` 覆盖范围。
- 静态 StateReport Shell 与 ZIP 解压 PowerShell 脚本进入包哈希；运行时不再生成
  编码或拼接的扫描敏感脚本。
- 更新解压前检查路径穿越、重复条目和展开大小，并以可补偿事务提交 Runtime 指针与状态。
- Release Runtime 在命令边界根据文件系统变更重新验证组件树，已识别的 Runtime 写路径会被 Guardrail 拒绝。
- 上述机制用于阻止意外修改继续传播，不等同于抵御恶意本地代码的 OS 级只读沙箱。
