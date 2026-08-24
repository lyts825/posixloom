# PosixLoom HTTP API v1

基础路径为 `/api/v1`。响应均为 UTF-8 JSON；流式执行使用 `application/x-ndjson`。每个响应包含 `requestId`，响应头同时带 `X-Request-Id`。

## 鉴权与跨域

配置 Token 后，除 `GET /api/v1/health` 外的端点都要求以下任一请求头：

```http
Authorization: Bearer <token>
X-PosixLoom-Token: <token>
```

非 loopback 监听没有 Token 会在启动阶段失败。带 `Origin` 的请求只有同源或精确命中 `--cors-origin` 才会被接受；预检支持 `GET, POST, DELETE, OPTIONS`。

## 基础端点

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/health` | 最小公开健康状态 |
| `GET` | `/capabilities` | 协议版本、流格式与启用能力 |
| `GET` | `/runtime` | RuntimeInfo |
| `GET` | `/runtime/doctor` | DoctorReport |
| `GET` | `/traces?limit=50` | 当前 HTTP 服务进程的内存 trace |

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

会话与服务进程同生命周期，不跨重启恢复。

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

### NDJSON 流

令 `stream: true` 或发送 `Accept: application/x-ndjson` 后，响应每行是一个独立 JSON 对象：

```text
{"type":"started","preview":{...}}
{"type":"output","stream":"stdout","sequence":0,"dataBase64":"aGVsbG8="}
{"type":"completed","result":{...}}
```

输出按 `sequence` 排序并提供背压。客户端关闭响应连接时，服务会取消关联的进程树。若响应头发出后失败，最后一行改为 `type: "error"`。

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

边界错误使用 `400/401/403/404/405/409/413`；未识别异常收敛为 `500`，不会返回堆栈。

