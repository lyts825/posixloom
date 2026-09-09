# 一切皆插件：运行时架构

PosixLoom 采用“微内核 + 插件能力图”。微内核只保留无法安全外移的规则：配置与 Runtime 完整性、插件生命周期、策略门、会话乐观锁和 StateReport 提交。命令相关能力——原生命令声明、argv 适配、分类、后端解析、计划构建和进程后端——全部由插件提供。

```text
                    PluginKernel
          依赖排序 / 扩展点 / 优先级 / 回滚
                         │
       ┌─────────────────┼──────────────────┐
       ▼                 ▼                  ▼
  Command plugins   Execution plugins   Observer plugins
  descriptor        resolver            lifecycle hook
  adapter            planner
  classifier         backend
       └─────────────────┼──────────────────┘
                         ▼
       policy + runtime integrity + session CAS
                   （不可替换微内核）
```

## 统一插件协议

可信的进程内插件实现 `RuntimePlugin`：

```ts
import {
  COMMAND_CLASSIFIERS,
  PosixLoomService,
  RuntimeManager,
  type RuntimePlugin,
} from "posixloom-runtime";

export const aliases: RuntimePlugin = {
  manifest: {
    id: "example.aliases",
    version: "1.0.0",
    description: "Project command aliases",
    requires: ["core.classifier.argv"],
    provides: [COMMAND_CLASSIFIERS.id],
  },
  activate(context) {
    context.provide(COMMAND_CLASSIFIERS, {
      id: "example.check-alias",
      classify({ input }) {
        if (input.kind !== "text" || input.raw !== "project:check") return undefined;
        return { kind: "simple", argv: ["node", "scripts/check.mjs"], reason: "project alias" };
      },
    }, { priority: 1000 });
  },
};
```

由组合根显式注入：

```ts
const runtime = await RuntimeManager.create(appRoot, { plugins: [aliases] });
const service = new PosixLoomService(runtime);
try {
  const sessionId = service.createSession();
  const completion = await service.execute({ sessionId, raw: "project:check" });
  process.stdout.write(completion.stdout);
} finally {
  await runtime.close();
}
```

`appRoot` 指向已有 PosixLoom Runtime 根目录，示例命令还要求宿主工作区包含 `scripts/check.mjs`。包导入方式与本地 tarball 安装步骤见[开发指南](development.md#嵌入-sdk)。

内置插件没有特殊通道；`createBuiltinRuntimePlugins()` 返回的也是同一种 `RuntimePlugin`。嵌入方可以设置 `includeBuiltinPlugins: false` 构造完全自定义的能力图，但必须自行提供服务运行所需扩展点。

## 扩展点

| 扩展点 | 合约 | 作用 |
|---|---|---|
| `command.native-descriptor` | `NativeCommandDescriptor` | 声明可走 Native Fast Path 的命令 |
| `command.native-adapter` | `NativeCommandAdapter` | 翻译 argv 与虚拟路径并留下路径决策 |
| `command.classifier` | `CommandClassifier` | 把 text/argv 输入分类为命令语义 |
| `command.resolver` | `CommandResolver` | 按优先级选择 native 或 MSYS2 模板 |
| `execution.planner` | `ExecutionPlanner` | 构建不可变执行计划 |
| `execution.backend` | `ExecutionBackend` | 执行匹配 mode 的计划 |
| `execution.hook` | `ExecutionHook` | 只读观察 prepare/execute 生命周期 |

同一扩展点允许多个贡献。`priority` 越高越先被咨询；同优先级按插件注册顺序和贡献顺序稳定排序。分类器、解析器和计划器采用“第一个接受请求的贡献”；后端采用“第一个匹配计划 mode 的贡献”。

## 生命周期与故障语义

- 插件 id 唯一，`requires` 构成有向无环依赖图；缺失依赖或环会在任何插件激活前失败。
- 插件只能向 `manifest.provides` 中声明的扩展点注册能力。
- 激活是事务：任一插件失败，会按逆依赖顺序撤销已激活及部分激活插件、执行 `defer()` 清理，并清空贡献。
- 停止同样按逆依赖顺序执行 `deactivate()` 与清理回调。
- Kernel 开始启动后关闭注册面，运行中不能静默改变能力图；Runtime 快照中的 registry hash 包含命令描述符与 adapter id。
- `runtime.info().plugins` 和 `runtime doctor` 提供不含函数与私有状态的插件清单。

## 安全边界：两类插件

“一切皆插件”不等于“自动执行市场代码”。PosixLoom 明确区分：

1. **RuntimePlugin**：可信、进程内代码，由宿主在 `RuntimeManager.create()` 时显式注入，权限等同宿主进程。
2. **市场命令包**：不可信数据，只包含经过验证的 JSON 命令配方。安装只原子写入 `$DATA/plugins/installed/`，显式 `plugin run` 后才进入同一策略、路径、超时和 trace 管道。

远程市场不会被转换成 `RuntimePlugin`，也不会加载 JavaScript、DLL 或安装脚本。若未来支持可下载代码插件，必须先增加独立签名信任链、权限模型与进程隔离，不能复用当前数据型市场的信任假设。

## 新能力的落点

新增命令语义或后端时，优先新增插件贡献，不修改 `PosixLoomService` 的分支。只有以下变化应进入微内核：新的安全不变量、会话一致性规则、Runtime 供应链校验或插件生命周期规则。这样扩展面可以快速演进，安全根仍保持小而可审计。
