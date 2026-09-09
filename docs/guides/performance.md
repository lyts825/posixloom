# 性能与资源边界

## 重复运行的基线

从仓库根目录执行（不会修改用户配置；使用临时 DataRoot/Workspace）：

~~~powershell
npm run benchmark:check
npm run benchmark -- --samples 30 --warmup 3 --output artifacts/benchmark.json
npm run benchmark -- --samples 30 --baseline artifacts/benchmark.json --output artifacts/benchmark-next.json
npm run benchmark -- --extended --samples 7 --output artifacts/benchmark-load.json
~~~

默认每项预热 3 次、测量 30 次，报告 p50、p95、按运行顺序保留的原始样本及
Node/CPU/OS/Runtime 信息。schemaVersion 2 明确区分三种入口：`cold.*` 直接通过
Node 启动 CLI；`launcher.*` 从公开 EXE 入口开始，包含 Launcher 的完整性校验；
`warm.*` 复用同一 Runtime 和 Service。`warm.initialize` 包含创建及关闭实例。
`warm.shell` 为 isolated，`warm.shell-cwd-env` 还验证状态提交。默认关闭自动更新和日志落盘，
因此这些数字不包含下载或持续审计的成本。

`--case cold.shell` 可以单独定位一个场景。`--run-root <package>` 可针对组装包测量；
脚本从候选包自身加载所有 Runtime、Service、HTTP 模块和相对资源。请用该包内
的 Node 执行脚本；发布模式发现 Node 可执行文件不一致时会拒绝测量。
报告记录实际 Node 路径、模块根目录、Launcher 路径和候选 SHA256SUMS 文件摘要。
脚本在检测到执行
失败时会中止，不能把错误路径当作更快的成功路径。

`--extended` 增加 8 命令并发、真实进程/Host 的 64 MiB 输出、HTTP NDJSON 的
64 MiB 输出以及每次读取延迟 2ms 的 1 MiB 客户端场景；后者只测延迟读取，
不保证耗尽网络缓冲区或触发子进程背压。也可通过
`--case load.http-output-64mib` 单独测量。输出场景检查实际字节数和完成事件，
并记录吞吐量与从请求开始计时的 `requestFirstByteMs`。进程输出场景另有从后端
进入计时的 `processFirstByteMs`，两者起点不同。RSS 每 10ms 采样，CPU 为 Node benchmark 进程用量，
两者不包含子进程，也不能当作整个进程树的精确峰值。进程冷启动不等于磁盘冷缓存。

`benchmarks/budgets.json` 是开发/发布两种配置的宽松 p95 回归门禁，不是性能承诺。
Windows CI 在 Node 22、24 上执行开发配置门禁及真实 HTTP 输出检查。7 次样本的
p95 等于样本最大值，只用于烟测；做性能结论时使用 30 次以上并检查原始分布。
schemaVersion 1 基线因测量方法不同不能直接用于自动比较。更精细的比较使用同机基线：
默认 p50 允许增幅为 `max(5ms, 25%)`，可用 `--max-regression 0.15` 调整。
比较要求 CPU、平台、架构、Node 大版本和 Runtime 模式一致；温度、后台扫描、
磁盘缓存等仍会带来噪声。不要用不同机器或冷/热混合样本宣称收益。

## 快路径评估

默认仍只有经过适配的 git、rg、node 原生快路径。开发模式的 PATH 发现直接访问
文件系统，不再启动 where.exe/which；正向缓存 2 秒、负向缓存 250 毫秒、最多
256 项，PATH/PATHEXT/cwd 变化会改变缓存键。发布模式仍使用 Runtime 内固定入口，
不会因为性能优化放宽完整性校验或宿主 PATH 回退。

启用本地诊断后评估下一批候选：

~~~json
{
  "observability": {
    "writeTraceFile": true,
    "collectCommandNames": true
  }
}
~~~

~~~powershell
posixloom trace summary --limit 1000 --json
~~~

HTTP 使用 `/api/v1/traces/summary?limit=1000`，stdio 使用 `trace.summary`。
报告给出样本量、原生命中率、阶段延迟、失败阶段与未命中注册表的简单命令名称。
命令名默认不采集；即使开启也不记录参数、脚本内容、环境值或绝对路径。

候选按样本中的累计执行时间排序。该时间包含命令本身的工作，**不是可节省的
Shell 启动时间**。先取得代表性真实负载，检查命令是否是 Shell builtin、
参数/路径语义和兼容性，再写适配器与等价性语料。不要仅因合成测试出现某个名称
就扩大默认注册表。

## 时延字段

`runtime info --json` 的 `initializationTimings` 包括配置、插件、注册表、manifest
和初始化总耗时（不含此前 Node 模块加载）。每条服务级执行/预览 trace 记录：

- `validateMs`、`queueMs`：请求校验、等候执行容量；
- `prepareMs`：准备总耗时，内部包含 integrityPre、policy、classify、resolve、
  plan、planValidate 与生命周期 hook；
- `executeMs`：后端总耗时；原生后端另有 spawn、firstByte、exit、processTotal；
- `integrityPostMs`、`stateCommitMs`：复验与结果/状态提交。

阶段值使用单调时钟；缺失表示没有进入该阶段，不表示耗时为零。父子阶段存在重叠，
不能相加。预检、策略、插件与入队失败也会留下 trace，不再只记录启动成功的进程。

## 内存和磁盘

Windows 下同一 MSYS 安装、同一用户的挂载表由 DLL 共享，one-shot Bash 本身
并不隔离挂载。Native Host 对这类 Shell 使用跨进程命名互斥量，从启动前保持到
整个 Job 的后代进程退出；等待期间支持取消，且计入命令超时。原生命令继续按
全局/客户端并发配置执行，不同物理 MSYS 安装也互不阻塞。

Host 崩溃后会清理并关闭旧的命名 Job，确认创建了全新对象后才启动下一条命令。
旧 Job 的活动进程数归零不代表 Windows 已完成对象终止，直接复用仍可能在
加入新进程时失败，参见 [AssignProcessToJobObject 的终止状态约束](https://learn.microsoft.com/en-us/windows/win32/api/jobapi2/nf-jobapi2-assignprocesstojobobject)。
恢复等待有上限，并再次检查取消和请求期限。

Windows Shell 要求带 `shell-namespace-v1` 能力的 Native Host；旧 Host 不会
收到待执行命令。Node 回退无法可靠追踪 MSYS fork/exec 改变的父进程链，因此
不用于 Windows Shell。互斥只协调 PosixLoom 自己的执行；若外部长期运行的
Git Bash/MSYS 进程使固定 `/tmp` 不符合当前 Runtime，启动会明确失败。应关闭
使用同一安装的外部 Shell，或使用完整包内独立的 MSYS 安装。

实现依据见 MSYS2 的 [共享 mountinfo 定义](https://github.com/msys2/msys2-runtime/blob/master/winsup/cygwin/shared_info.h)、
[按用户/安装共享映射](https://github.com/msys2/msys2-runtime/blob/master/winsup/cygwin/shared.cc) 与
[usertemp 挂载实现](https://github.com/msys2/msys2-runtime/blob/master/winsup/cygwin/mount.cc)。

一个 Runtime 的所有 Service/HTTP/stdio 共用执行调度器、trace 环形缓冲。
默认最多 8 个执行槽、每客户端 4 个，等待队列 128 个、每客户端 32 个。
同会话 cwd-env 等待不占用执行槽，并按进入调度器的顺序执行，包括不同客户端
提交的请求。客户端限额阻塞会话的首个请求时，后续请求仍需等待；其他会话可继续
使用空闲执行槽。isolated 执行也持有会话租约。
容量和超时含义见[配置指南](configuration.md)。

输出用固定容量头尾环形缓冲，帧解码按报文长度一次分配并线性拷贝分片，避免
每块 Buffer.concat 引起重复复制。确定性随机测试覆盖分片、Unicode、非法长度、
无效 UTF-8、截断和头尾保留等边界。

trace 默认保存最近 5000 条。落盘启用后按批次异步写入，默认队列 1 MiB、
100ms 刷盘、每文件 10 MiB，保留当前文件及 3 个历史文件。IO 失败或队列满只增加
诊断计数，不改变已执行命令的结果。它是尽力诊断，不是事务审计日志。
同进程的同路径写入串行化；多个独立进程应使用独立 DataRoot，或外接集中日志系统。
