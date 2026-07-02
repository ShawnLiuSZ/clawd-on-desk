## v0.11.0-fork.1

v0.11.0-fork.1 是 fork 版本的第一个发布，基于 v0.11.0 上游，并集成了以下 fork 特有功能：

### Fork 特有功能

- **MiMo Code 集成** — 新增 MiMo Code agent 支持，通过 plugin 系统实现状态上报与双 prompt 权限审批模式
- **QQ 机器人远程审批** — 通过 QQ 官方机器人实现远程权限审批与通知集成，支持多选 elicitation 和卡片按钮 i18n
- **微信 ilink 远程审批** — 通过个人微信 Bot API 实现远程权限审批，支持 QR 码登录和审批桥接
- **飞书/Lark 机器人远程审批** — 通过 WebSocket 长连接实现远程审批，支持多选 elicitation、飞书/Lark 双区域、设置 UI

### 上游 v0.11.0 包含的功能

- 首次运行引导教程
- 自由漫游模式
- 眩晕旋转反应
- Windows 全屏叠加模式
- Codex 官方 hook 健康检测
- Remote SSH 启动时连接
- 设置 UI 清理和重构
- 各种错误修复和加固

### 升级说明

- 发布元数据已升级到 `0.11.0-fork.1`
- 升级提醒和 About 页面仓库链接已指向 fork 仓库 `ShawnLiuSZ/clawd-on-desk`

### 已知限制

- QQ/微信/飞书远程审批功能需要额外配置 bot token，详见各集成文档
- MiMo Code 集成需要安装 plugin，首次使用请通过 Settings -> Agents 安装
- 上游 v0.11.0 的已知限制同样适用
