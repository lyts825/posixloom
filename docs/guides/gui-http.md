# GUI 与远程 HTTP

## 组件边界

GUI、HTTP 服务与插件市场是三个独立组件，源码实现不互相 import：

```text
                  ┌───────────────┐
Browser ─HTTP v1─→│ GUI static app │  （只知道 API URL 与公开协议）
                  └───────────────┘
                           │ HTTP v1
                           ▼
Core API ← stable API ─ HTTP adapter

Plugin marketplace          （独立目录、校验与安装）
        │
        └─ optional composition adapter ─→ generic HTTP extension port
```

`src/composition/` 是唯一允许同时知道两个组件的适配层；CLI 是组合根。删除该适配器只会让 HTTP capabilities 中不再出现 `plugins`，不会影响远程执行服务。`tests/decoupling.test.ts` 会阻止实现层重新引入跨组件 import。

## 本地组合启动

```powershell
npm run gui
```

该命令为了方便会同时启动两个独立监听器：

- `http://127.0.0.1:7330`：只提供 HTML/CSS/JS 和不含密钥的 `config.json`；
- `http://127.0.0.1:7331`：只提供 `/api/v1/*` JSON API。

使用 `--no-open` 可禁止自动打开默认浏览器。端口和监听地址可用 `--host`、`--port`、`--api-host`、`--api-port` 分别设置。

## 分离部署

GUI 可以只作为静态服务启动并连接已有 API：

```powershell
npm run posixloom -- gui --api-url https://posixloom.example.com --host 127.0.0.1 --port 7330
```

远程 API 可单独启动：

```powershell
$env:POSIXLOOM_HTTP_TOKEN = 'a-long-random-secret-at-least-16-bytes'
npm run posixloom -- serve --http `
  --host 0.0.0.0 `
  --port 7331 `
  --cors-origin https://console.example.com
```

非 loopback 监听强制要求至少 16 字节的 Bearer Token。客户端通过 `Authorization: Bearer <token>` 或 `X-PosixLoom-Token` 发送；GUI 只把 Token 放在当前标签页的 `sessionStorage`，不会写进 URL 或服务端配置。

无 Token 的 loopback 服务还会把请求 `Host` 限定为实际监听端口上的 loopback
地址（含 `localhost`、`127.0.0.1` 和 `::1`），并用这组服务端来源校验
`Origin`。因此浏览器请求不能通过伪造的重绑定域名把攻击者来源冒充为同源。

HTTP 服务不内置 TLS。跨主机部署应放在 HTTPS 反向代理之后，并只配置确切的 `--cors-origin`。健康端点公开但只返回最小状态；其余 API 在配置 Token 时都需要鉴权。

## 环境变量

| 变量 | 默认值 | 用途 |
|---|---:|---|
| `POSIXLOOM_GUI_HOST` | `127.0.0.1` | GUI 监听地址 |
| `POSIXLOOM_GUI_PORT` | `7330` | GUI 监听端口 |
| `POSIXLOOM_HTTP_HOST` | `127.0.0.1` | API 监听地址 |
| `POSIXLOOM_HTTP_PORT` | `7331` | API 监听端口 |
| `POSIXLOOM_HTTP_TOKEN` | 空 | API Bearer Token |
| `POSIXLOOM_MARKETPLACE_URL` | 空 | 可选 HTTPS 插件目录 |

完整端点与流格式见 [HTTP API v1](../protocols/http-v1.md)。

## 大输出显示

控制台只保留最近最多 1 MiB、256 个文本块和 2,000 个换行（任一上限先到即
裁剪），以动画帧批量绘制。裁剪会显示提示；查看历史时保持位置，可用“回到最新”
恢复自动滚动。该显示上限独立于服务端命令输出回执上限。

NDJSON 单帧上限为 32 MiB，覆盖默认两路各 8 MiB 输出的 Base64 完成回执。
如果服务端自定义更大回执，GUI 会明确报错并取消流；畸形 JSON、非法 UTF-8、
超长未结束帧和事件处理异常也会及时关闭读取，避免无限保留输入。
