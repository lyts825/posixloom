# StateReport v1

StateReport 是 one-shot Bash 完成后由 PosixLoom（`posixloom` 兼容控制面）读取的临时文件协议。它不使用 stdout magic delimiter，也不依赖 MSYS Bash 继承高编号 Windows FD。

## 文件生命周期

```text
DataRoot/tmp/posixloom-<commandId>.report
  → Bash 在完成用户命令后创建并写入
  → Node 在进程退出后读取
  → Node 校验并按 CAS 提交
  → Node 删除文件
```

报告缺失、截断、权限异常、版本错误、非规范编码或进程终态不是 `exited` 时，SessionState 不变。文件与兼容 fd 通道都受 `process.maxReportBytes` 独立硬上限约束；读取器每次只取有界分片，不会先把超大文件整体载入内存。

## 格式

```text
__POSIXLOOM_REPORT_V1\n
exit-code=<signed decimal>\n
cwd-b64=<standard base64 without trailing newline>\n
env-bytes=<decimal byte count>\n
<env-bytes bytes: NUL-separated NAME=value entries>
__POSIXLOOM_REPORT_END\n
```

`env-bytes` 使 Node 可以在不猜测 NUL 数据边界的情况下读取报告。元数据标签必须精确匹配，cwd 必须使用规范 Base64/UTF-8 并落在已挂载且存在的合法 virtual namespace；环境值不得包含 NUL，名称必须是合法 POSIX 标识符，大小写折叠后重复的名称会使整个报告失败。结束标记后不得有额外字节。

## 提交语义

`isolated` 命令使用只包含退出码的 CompletionReport v1，不采集 cwd 或环境：

```text
__POSIXLOOM_COMPLETION_V1\n
exit-code=<0..255 canonical decimal>\n
__POSIXLOOM_REPORT_END\n
```

轻量回执使用 Bash 内建命令写入同一临时文件，不派生 env/base64/wc/tr。
它只允许用于 isolated 计划；cwd-env 计划仍要求完整 StateReport。为兼容可信
自定义后端，isolated 仍接受并严格校验完整 v1 报告，但不会提交状态。
退出码必须与实际进程一致；报告写入失败仍退出 240，提前 exit/exec、取消、超时
和报告缺失保持下述语义。轻量回执不是跳过完成校验。

- `exit-code` 是用户命令的业务退出码，不是报告写入状态。
- 合法 `cwd` 和 exported env patch 可在非零退出码时提交。
- `set -e`、`exit`、`exec` 或终止导致报告缺失时返回 `not-produced`，不提交。
- 即使报告完整，`cancelled`、`timed-out`、`crashed` 或 `spawn-failed` 终态也必须忽略报告并保持 SessionState 不变。
- `baseStateVersion` 由创建 wrapper 的 PosixLoom plan 绑定；过期版本返回 `STATE_CONFLICT`。
