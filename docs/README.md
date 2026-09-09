# PosixLoom 文档

- [项目 README](../README.md)：项目简介、快速开始和仓库结构。
- [开发指南](guides/development.md)：环境准备、常用命令、测试与故障排查。
- [配置与诊断](guides/configuration.md)：配置路径、执行计划预览、运行时摘要与 trace。
- [性能与资源边界](guides/performance.md)：可复现基线、执行配额、分阶段 trace 与快路径候选。
- [优化实施与验收记录](guides/optimization-report.md)：本轮优化项、验证证据与外部发布门禁边界。
- [GUI 与远程 HTTP](guides/gui-http.md)：独立组件、组合启动、鉴权、CORS 与远程部署。
- [任务工作台](guides/task-workbench.md)：参数任务、后台续接、产物、会话快照、浏览器终端和排障报告。
- [插件市场](guides/plugins.md)：声明式清单、目录发现、安装与显式运行。
- [一切皆插件架构](guides/plugin-architecture.md)：运行时插件内核、扩展点、生命周期与安全边界。
- [发布与更新指南](guides/release.md)：组件同步、Runtime 组装、签名和验证。
- [HTTP API v1](protocols/http-v1.md)：远程会话、执行、流输出及扩展端点。
- [Control protocol v1](protocols/control-v1.md)：Harness 与 `posixloom serve --stdio` 之间的长度前缀 JSON 协议。
- [StateReport v1](protocols/state-report-v1.md)：one-shot Bash 回传 cwd、环境和退出状态的文件协议。
