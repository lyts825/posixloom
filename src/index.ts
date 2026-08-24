/**
 * =============================================================================
 * PosixLoom 库公共出口
 * =============================================================================
 *
 * 【职责】
 * 汇聚 core/ 下全部模块的导出，构成包的公共 API 面：外部（posixloom-host、
 * harness、测试与上层工具）只从这里 import。
 *
 * 【为什么按依赖顺序导出】
 * 下方顺序大体是自底向上的分层依赖顺序：
 *   第 0 层：零依赖、零逻辑的类型字典与统一错误类型；
 *   第 1 层：配置装载与路径翻译基础层；
 *   第 2 层：策略 / 环境 / 会话 / trace 等横切能力；
 *   第 3 层：命令分类与注册表解析（命令理解层）；
 *   第 4 层：运行时装载、校验与供应链更新器（运行时生命周期层）；
 *   第 5 层：进程执行原语、编排服务与宿主控制协议（顶层入口）。
 * 虽然对 ESM 而言 re-export 的书写顺序不影响加载语义，但保持分层顺序能让
 * 读者按序阅读即获得自底向上的完整心智模型，也便于审查分层是否被越层依赖
 * 破坏。
 *
 * 【注意】
 * 每行都是 export * 聚合导出；新增公共模块应追加到对应分层的位置，
 * 不要调整既有行的顺序（导出顺序本身是稳定公共契约的一部分）。
 */

// 第 0 层：全库类型字典与统一错误类型（零逻辑、零依赖，被所有上层模块引用）。
export * from "./core/types.js";
export * from "./core/errors.js";
// 第 1 层：配置加载 / 深度合并与运行时指针选择；虚拟与宿主路径双向翻译（MountTable）。
export * from "./core/config.js";
export * from "./core/path.js";
// 第 2 层：横切能力--读写策略门（PolicyGate）、环境变量规范化与状态补丁校验、
// 会话状态存储（乐观锁 CAS）、trace 环形缓冲与落盘。
export * from "./core/policy.js";
export * from "./core/env.js";
export * from "./core/session.js";
export * from "./core/trace.js";
// 第 3 层：命令四级分类（simple/builtin/shell-required/explicit-shell）与
// 原生命令注册表解析（含参数级路径审计 PathDecision）。
export * from "./core/classifier.js";
export * from "./core/registry.js";
// 第 4 层：运行时装载 / 完整性校验 / 快照合成与热更新检测；供应链更新器
//（更新 feed 拉取、签名校验、下载限额与原子应用）。
export * from "./core/runtime.js";
export * from "./core/updater.js";
// 声明式插件市场：清单校验、远程目录发现与 DataRoot 原子安装。
export * from "./plugins/marketplace.js";
// 第 5 层：进程执行原语（spawn / 超时取消 / 输出截断 / 帧协议）、命令编排
// 服务门面（计划构建与 StateReport 提交）与宿主控制协议（帧编解码与请求分发）。
export * from "./core/control.js";
export * from "./core/process.js";
export * from "./core/service.js";
// 可独立启动的远程 HTTP/JSON 适配器；不引用 GUI 或插件市场实现。
export * from "./http/server.js";
// 独立静态 GUI 服务；只接收 API URL，不引用控制服务或插件实现。
export * from "./gui/server.js";
// 显式组合适配器位于组件之外，避免 HTTP 与插件市场互相依赖。
export * from "./composition/plugin-http.js";
