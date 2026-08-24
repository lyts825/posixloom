# 插件市场

PosixLoom 插件是声明式命令包，不是加载到服务进程中的 JavaScript、DLL 或 Shell 启动脚本。安装操作只会验证 JSON 清单并原子写入 `$DATA/plugins/installed/<id>.json`；不会执行清单中的命令。

## 使用

```powershell
# 搜索内置与远程目录
npm run posixloom -- plugin search git

# 安装后查看
npm run posixloom -- plugin install git-review
npm run posixloom -- plugin list

# 只有显式 run 才会执行，并继续经过正常策略/路径/超时/trace 管道
npm run posixloom -- plugin run git-review diff-check

npm run posixloom -- plugin uninstall git-review
```

GUI 中的“载入”也只把命令放进编辑器，仍需用户再次点击“执行”。

## 远程目录

用 `--marketplace https://example.com/posixloom-catalog.json` 或 `POSIXLOOM_MARKETPLACE_URL` 指定目录。远程目录必须使用 HTTPS；仅 `localhost`、`127.0.0.1` 与 `::1` 允许明文 HTTP，便于本地开发。

目录格式：

```json
{
  "schemaVersion": 1,
  "plugins": [
    {
      "manifestVersion": 1,
      "id": "example-tools",
      "name": "Example Tools",
      "version": "1.0.0",
      "description": "Read-only project helpers.",
      "author": "Example",
      "category": "Development",
      "tags": ["example"],
      "commands": [
        {
          "id": "status",
          "title": "Status",
          "description": "Show repository status.",
          "input": { "kind": "argv", "argv": ["git", "status", "--short"] }
        }
      ]
    }
  ]
}
```

`input.kind` 可为精确 `argv` 或原样 `text`。id、版本、字段长度、命令数量、argv 数量和超时都在安装前按上限验证；文件名只由校验后的 id 推导，不能包含路径穿越字符。远程目录默认限制为 2 MiB、10 秒，并拒绝重定向。

远程目录受 HTTPS 传输保护，但当前版本不提供独立的目录签名信任链。只应配置可信市场；安装前可在 GUI 中检查每条声明式命令。

