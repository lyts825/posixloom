# 插件市场

本页描述市场中的**数据型命令包插件**：它不是加载到服务进程中的 JavaScript、DLL 或 Shell 启动脚本。安装操作只会验证 JSON 清单并原子写入 `$DATA/plugins/installed/<id>.json`；不会执行清单中的命令。

命令分类器、解析器、计划器和后端使用可信的进程内 `RuntimePlugin` 协议，详见[一切皆插件架构](plugin-architecture.md)。两类插件共享“能力可组合”的设计，但刻意采用不同信任边界：远程命令包永远不会自动变成进程内代码插件。

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

`input.kind` 可为精确 `argv` 或原样 `text`。id、版本、字段长度、命令数量、argv 数量和超时都在安装前按上限验证；文件名只由校验后的 id 推导，不能包含路径穿越字符。远程目录默认限制为 2 MiB、10 秒，正文按流读取并在越界时立即取消，同时拒绝重定向。内置插件 id 是保留命名空间，远程目录和安装记录都不能用更高版本覆盖它。

安装记录先写同目录临时文件，再以单次原子 rename 发布。若平台无法原子替换
已有记录，安装会失败并保留旧记录；不会先删除可用版本再尝试移动新文件。

远程目录受 HTTPS 传输保护，但当前版本不提供独立的目录签名信任链。只应配置可信市场；安装前可在 GUI 中检查每条声明式命令。
