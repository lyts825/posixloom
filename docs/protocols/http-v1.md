# PosixLoom HTTP API v1

基础路径为 `/api/v1`。响应均为 UTF-8 JSON；流式执行使用 `application/x-ndjson`。每个响应包含 `requestId`，响应头同时带 `X-Request-Id`。

## 鉴权与跨域

配置 Token 后，除 `GET /api/v1/health` 外的端点都要求以下任一请求头：

```http
Authorization: Bearer <token>
X-PosixLoom-Token: <token>
```

非 loopback 监听没有 Token 会在启动阶段失败。无 Token 的 loopback 监听还会
拒绝不属于实际服务地址的 `Host`，包括预检与健康请求。带 `Origin` 的请求只有
命中服务端确定的监听来源或精确命中 `--cors-origin` 才会被接受；预检支持
`GET, POST, DELETE, OPTIONS`。

## 基础端点

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/health` | 最小公开健康状态 |
| `GET` | `/capabilities` | 协议版本、流格式与启用能力 |
| `GET` | `/runtime` | RuntimeInfo |
| `GET` | `/runtime/doctor` | DoctorReport |
| `GET` | `/traces?limit=50` | 当前 HTTP 服务进程的内存 trace |
| `GET` | `/traces/summary?limit=50` | 有界 trace 样本的阶段耗时、命中率和回退候选 |
| `GET` | `/metrics` | 执行配额、请求数、日志丢弃与幂等回执占用 |
| `GET` | `/schema` | 执行请求 JSON Schema（不包装 requestId） |
| `GET` | `/openapi.json` | OpenAPI 3.1 契约（不包装 requestId） |

## 会话

```http
POST /api/v1/sessions
Content-Type: application/json

{"cwd":"/workspace"}
```

返回 `201` 与 `{sessionId,state}`，其中 `state.version` 是十进制字符串。还支持：

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/sessions` | 列出此 HTTP 服务创建的会话 |
| `GET` | `/sessions/{id}` | 会话快照 |
| `DELETE` | `/sessions/{id}` | 关闭会话 |

活动会话不自动跨重启恢复；可通过 checkpoint 端点显式保存并恢复为新会话。初始 cwd 必须是规范化、策略允许且真实存在的虚拟目录。
空闲会话按 `session.idleTimeoutMs` 过期，总量受 `session.maxSessions` 限制；达到
上限时会回收最久未使用的非活动会话，所有会话都在活动时返回 `429`。
执行中和排队中的会话（包括 isolated）不能关闭，返回 `409 SESSION_BUSY`。

## 计划与执行

`POST /sessions/{id}/explain` 和 `POST /sessions/{id}/execute` 共用请求：

```json
{
  "input": { "kind": "argv", "argv": ["git", "status", "--short"] },
  "cwd": "/workspace",
  "envDelta": { "NAME": "value", "REMOVE_ME": null },
  "statePolicy": "cwd-env",
  "timeoutMs": 30000,
  "stream": false
}
```

`input` 也可为 `{ "kind": "text", "raw": "printf hello | grep hello" }`。`argv` 永不重新拼接为 Shell 文本。

非流式执行返回 `result`，stdout/stderr 使用 `stdoutBase64` 与 `stderrBase64` 无损编码，另外包含真实字节数、截断位、后端、planId、终态和 trace。

与 CLI/stdio 共用语义校验：text 与 argv JSON 各不超过 1 MiB UTF-8；argv 最多
4096 项，每项不超过 32768 字节；envDelta JSON 另有 1 MiB 上限。环境变量名须匹配
`[A-Za-z_][A-Za-z0-9_]*`，字符串不得含 NUL。timeoutMs 必须是 1..2147483647 的整数。
本节的同步 execute/explain 端点不支持 terminal；交互执行通过新增 jobs 端点提供。Schema 中的 x-maxUtf8Bytes
是服务端补充的字节限制，通用 JSON Schema 验证器还应按它检查 UTF-8 长度。

默认一个 Runtime 最多同时执行 8 个请求，每客户端 4 个；队列总长 128、每客户端
32 个。客户端按实际 socket 地址识别，不信任转发头。队列满为 `429 SERVER_BUSY`，
排队超过 30 秒为 `429 QUEUE_TIMEOUT`，均带 `Retry-After: 1`。预览同样经过准入。
这与执行超时分开；实际配置在 capabilities 中公布。传输层另限最多 256 个在途请求。

### 安全重试与幂等回执

执行请求可附带 `Idempotency-Key`（1..128 个 ASCII 字母、数字或 `._:-`）：

```http
Idempotency-Key: job-123-command-4
```

同键、同会话和同规范化请求（忽略 stream/Accept 差异）复用首次执行结果，返回
`Idempotency-Replayed: true`；环境对象键顺序不影响身份。首次仍在运行时返回
`409 IDEMPOTENCY_IN_PROGRESS`，同键不同请求返回 `409 IDEMPOTENCY_CONFLICT`。
不提供键不会去重，客户端不得自动重试有副作用的命令。

回执仅在当前 HTTP 服务实例内保存，默认完成后 30 分钟、最多 1024 项和 32 MiB
结果数据。容量满时拒绝新键，不提前淘汰仍受保护的键。过大的结果只留下占位记录，
重试返回 `409 IDEMPOTENCY_RESULT_UNAVAILABLE`，绝不因为没保存结果而重新执行。
确定在获得执行槽之前被拒绝的 `SERVER_BUSY` / `QUEUE_TIMEOUT` 不会保存成不可重试的
执行结果；容量恢复后可用同键、同请求重试，原指纹仍受保护，换请求仍返回冲突。
一旦获得执行槽，后续失败（即使错误码也为 `SERVER_BUSY` / `QUEUE_TIMEOUT`）、取消和
结果丢失都保留首次回执或占位，避免重复副作用。排队取消也仍保留取消结果。
过期、服务重启、换服务实例后不提供去重保证，
这不是跨重启的 exactly-once 事务机制。

### NDJSON 流

令 `stream: true` 或发送 `Accept: application/x-ndjson` 后，响应每行是一个独立 JSON 对象：

```text
{"type":"started","preview":{...}}
{"type":"output","stream":"stdout","sequence":0,"dataBase64":"aGVsbG8="}
{"type":"completed","result":{...}}
```

输出按 `sequence` 排序并提供背压。客户端关闭响应连接时，服务会取消该连接上
所有关联的进程和待写响应，包括 HTTP/1.1 流水线中尚未获得 socket 的响应。
普通 JSON 响应和每次事件写入均受 `process.outputDrainTimeoutMs` 排空期限约束，包括
`started`、`output`、`completed`、错误响应和两种格式的幂等重放。请求计数保留到实际
写入/结束回调完成，HTTP/1.1 流水线中等待前一响应的写入同样有期限。
超时会关闭连接并释放待写请求。
进程输出转发失败时，命令内部终态为 `OUTPUT_SINK_FAILED`，不会尝试写完成帧；
命令完成后的回执写入失败不改变已保存的执行结果。若响应头
发出后发生其他失败，最后一行改为 `type: "error"`。
响应头只在开始发送事件时发出，因此准入/预检拒绝仍返回正确的 HTTP 错误码。
幂等流式重放仅包含一个 `completed` 事件，不重新发送 started/output 或重启命令。
非流式请求断连也会取消关联命令；服务关闭会取消并等待两种形式的在途工作及日志刷盘。

`/openapi.json` 的 components.schemas 定义会话、执行预览、命令/状态终态、完成回执、
错误及 NDJSON 事件。版本号为十进制字符串，输出为 Base64；NDJSON 响应 Schema
描述每一行的事件而非整段文本。trace 和额外对象属性允许扩展，客户端应忽略未知字段。
契约回归用实际 HTTP 响应覆盖成功、取消、截断、失败和只含完成事件的重放。

## 任务工作台资源

`/jobs` 提供客户端断线后继续运行的任务，输出归档可按序号续读；`/tasks` 管理项目
参数清单，`/checkpoints` 与会话子资源提供显式保存、恢复和分叉。交互终端通过
任务的 input/resize/eof 子资源控制。`/diagnostics` 导出白名单排障报告。
完整请求、限制与恢复语义见[任务工作台](../guides/task-workbench.md)，所有端点也在
`/openapi.json` 发布。它们使用与原有端点相同的 Bearer、Host、CORS 和请求大小检查。

## 可选扩展

HTTP 实现只暴露通用扩展端口，不引用任何扩展实现。CLI 装配插件适配器时，capabilities 增加 `plugins`，并提供：

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/plugins/catalog?q=` | 搜索目录并附带安装状态 |
| `GET` | `/plugins/installed` | 已安装清单 |
| `POST` | `/plugins/{id}` | 安装或更新；不执行命令 |
| `DELETE` | `/plugins/{id}` | 卸载 |

`--no-plugins` 会移除整个扩展，不影响 HTTP 核心端点。

## 错误

非流式错误结构稳定为：

```json
{
  "error": {
    "code": "HTTP_EXECUTE_INVALID",
    "message": "execute requires an input object",
    "details": {}
  },
  "requestId": "..."
}
```

边界错误使用 `400/401/403/404/405/409/413/429`；未识别异常收敛为 `500`，不会返回堆栈。
