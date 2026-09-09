# 任务工作台

PosixLoom 在原有单命令执行之外提供项目任务、后台任务、输出归档、产物下载、
会话快照、浏览器交互终端与排障报告。运行 `npm run gui` 打开工作台。

## 项目任务

项目清单位于 `/workspace/.posixloom/tasks.json`。可在 GUI 的任务页编辑 JSON 并保存，
或参考 [完整示例](../../examples/project-tasks.json)。清单格式为
`{ "schemaVersion": 1, "tasks": [...] }`。每个任务包括 `id`、可选 `title`、
`parameters`、串行 `steps` 和可选的虚拟 `artifacts` 文件路径。

```json
{
  "schemaVersion": 1,
  "tasks": [{
    "id": "echo",
    "parameters": { "message": { "type": "string", "default": "hello" } },
    "steps": [{
      "id": "print",
      "input": { "kind": "argv", "argv": ["node", "-e", "console.log(process.argv[1])", "${message}"] }
    }]
  }]
}
```

参数类型支持 `string` 和带 `values` 的 `enum`，可指定 `default` 与 `required`。
`${name}` 占一个完整 argv 参数；空格、引号和 Shell 元字符仍属于该参数。
环境值与路径字段也支持参数替换。Shell `raw` 是固定脚本，不插入任务参数；
可通过 `envDelta` 显式传值，并在固定脚本里引用环境变量。未知参数、缺失的必填值、
非法路径、保留环境变量和超大清单在提交前被拒绝。

步骤共用选定会话，分别支持 `cwd`、`envDelta`、`timeoutMs`、`statePolicy`。
前一步失败、超时或取消后，后续步骤不再启动。取消作用于当前进程树和未启动步骤。
每条实际命令仍经过原有分类、策略、运行时完整性与准入管道。

```powershell
posixloom task list
posixloom task show echo --param message=hello
posixloom task run echo --param message=hello
posixloom task run echo --param message=hello --json
```

`task run` 在本地前台执行并将任务归档；Ctrl+C 取消任务。后台执行需向正在运行的
HTTP 服务提交任务。安装、保存或浏览清单均不会自动执行。

## 后台任务与输出续读

先用 `POST /api/v1/sessions` 创建会话，再提交：

```http
POST /api/v1/jobs
Content-Type: application/json
Idempotency-Key: build-request-001

{"sessionId":"<id>","input":{"kind":"argv","argv":["node","--version"]}}
```

任务返回 `202` 和 `{job}`，其中 `job.jobId` 是查询句柄。项目任务请求使用
`{ "sessionId": "<id>", "taskId": "echo", "parameters": { "message": "hello" } }`。

| 接口 | 用途 |
|---|---|
| `GET /jobs?sessionId=<id>` | 列表与已归档历史 |
| `GET /jobs/{id}` | 状态、逐步骤结果、产物元数据 |
| `GET /jobs/{id}/events?after=-1&limit=256` | 按序号读取日志事件 |
| `POST /jobs/{id}/cancel` | 取消任务 |
| `DELETE /jobs/{id}` | 删除已结束任务和归档文件 |

表内路径均相对于 `/api/v1`。输出事件包含 `type: "output"`、`sequence`、
`stepId`、`stream`、`dataBase64`，因此二进制与分片 UTF-8 不会丢失。
响应 `nextSequence` 为最后返回的事件序号；下一次将其作为 `after`。
`hasMore` 为真时继续取下一页，否则稍后轮询。初始 `after` 为 -1，
每页最多 1024 条。完成时再读到末页可取得最后一批输出。

客户端断开不会取消后台任务。服务关闭会取消任务并刷盘；意外退出后，
遗留活动记录恢复为 `interrupted`，由用户决定下一步，不会自动重跑。
完成历史和产物跨服务重启保留。底层进程不跨服务重启恢复。

`Idempotency-Key` 复用原始提交回执；它只在当前 HTTP 服务实例的回执保留期内有效，
不保证跨重启去重。原有 `/sessions/{id}/execute` 的断连取消语义保持有效。

```powershell
posixloom job submit --request job.json --api-url http://127.0.0.1:7331
posixloom job list
posixloom job show <jobId>
posixloom job events <jobId> --after -1
posixloom job cancel <jobId>
```

`job.json` 包含与 POST 请求相同的字段；缺少 sessionId 时 CLI 创建新会话。
远程命令默认连接 `http://127.0.0.1:7331`，鉴权读取 `POSIXLOOM_HTTP_TOKEN`
或 `--token`。GUI 根据 API 来源保存当前会话选择，历史取自服务端。

## 日志与产物

每个结束任务归档 `output.ndjson`。显式声明的产物按虚拟路径读取并复制到该任务的
归档目录；返回文件名、字节数和 SHA-256。源文件后来变化不影响已归档副本。
只接受符合挂载与读策略的普通文件，拒绝链接、目录和越界路径。

`GET /jobs/{id}/artifacts/{artifactId}?offset=0&limit=262144` 返回
`dataBase64`、`eof` 等元数据。`offset` 是原始字节偏移，每次最多 1 MiB。
GUI 自动拼接分段并下载；AI 宿主可以只读取需要的部分。

命令失败时仍尝试保存已生成的声明产物，例如失败测试的报告；缺失或无法归档的
文件记录在 `artifactErrors`，保留原命令失败结果。取消和服务关闭会停止产物采集。

用户配置中的 `jobs` 控制磁盘与任务容量：

| 字段 | 默认值 |
|---|---|
| `maxJobs` | 256 条历史 |
| `maxActiveJobs` | 32 个运行或等待中的任务 |
| `maxLogBytes` | 每任务 64 MiB NDJSON |
| `maxArtifactBytes` | 每个产物 64 MiB |
| `maxTotalBytes` | 512 MiB 总存储 |
| `retentionMs` | 7 天 |

归档受配额与保留期约束，达到限制会显式报告截断或错误。普通执行结果的
`process.maxOutputBytes` 仍是独立的内存上限。一个 DataRoot 的任务存储由一个
JobManager 持有，任务历史按工作区分区。相同工作区的 CLI 本地任务与 HTTP 服务同时使用时应选择不同 DataRoot，
或统一通过 HTTP 提交。

## 会话保存、恢复与分叉

GUI 的会话工具可保存快照、从快照恢复或分叉当前会话。

```http
POST /api/v1/sessions/<id>/checkpoint
Content-Type: application/json

{"name":"build environment","envKeys":["BUILD_MODE"]}
```

`envKeys` 缺省为空，只保存 cwd；选定环境值保存在本机 DataRoot 的快照文件，
列表 API 仅公开键名。快照携带运行时指纹、创建时间和结构版本。
`GET /checkpoints` 列表，`POST /checkpoints/{id}/restore` 恢复，
`DELETE /checkpoints/{id}` 删除。恢复使用当前运行时重验 cwd 和环境，
创建版本为 0 的新会话。`POST /sessions/{id}/fork` 复制当前 cwd 和可变环境到新会话。

这些操作保存会话状态；文件内容、运行中进程、Shell 函数不属于快照。
原有 `session.persistAcrossRestart: true` 仍不作为自动恢复开关。

```powershell
posixloom checkpoint save <sessionId> --name build --env-key BUILD_MODE
posixloom checkpoint list
posixloom checkpoint restore <checkpointId>
posixloom checkpoint fork <sessionId>
```

## 浏览器终端与排障报告

GUI 的交互模式在单命令任务中传入 `terminal: {"columns":80,"rows":24}`，
通过本地打包的 xterm 显示真实 ANSI 屏幕。终端输入、缩放和 EOF 分别使用
`POST /jobs/{id}/input`（`dataBase64`）、`resize`（`columns` / `rows`）和 `eof`。
Windows ConPTY 由原有 Native Host 提供，输入队列与进程取消仍有界。

运行时页和任务详情可下载排障报告。`GET /diagnostics?jobId=<id>` 或
`posixloom diagnostics --job <id> --api-url http://127.0.0.1:7331 --output report.json`
导出按白名单整理的运行时指纹、doctor 检查状态、配置限额、计划摘要和关联 trace。
命令正文、参数、环境值、路径、输出正文与自由文本错误不进入报告。
省略 `--api-url` 和 `--job` 时 CLI 导出本地运行时报告；`--output` 只创建新文件。

## 嵌入式宿主

SDK 导出 `JobManager`、`ProjectTaskStore`、`SessionCheckpointStore` 和
`diagnosticReport`。`await JobManager.create(service)` 创建任务存储，
`submit` 接收 `sessionId`、`steps` 与可选 `artifacts`/`terminal`；`wait(jobId)`
等待终态。宿主退出前先 `await jobs.close()` 取消并等待后台任务，再
`await runtime.close()` 释放运行时资源。HTTP 与 CLI 已管理这一关闭顺序。
