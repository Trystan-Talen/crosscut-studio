# REA 使用决策

状态：暂不安装；遇到具体复杂前端问题后再引入。

独立审查结论：浏览器可以直接观察导航、字段、操作反馈和页面状态。REA 的额外价值在于对前端模块关系、延迟加载脚本及复杂状态做证据分析。目前尚未发现需要它才能解决的问题。

REA 的浏览器 CDP 接口主要是被动观察，不替代点击、输入、导航。网络窗口只包含连接后的事件。静态脚本不能证明运行时因果，也不能恢复后台实现、数据库或供应商权限。

若采用：固定并审阅版本，放在本目录同级 tools/rea；只针对明确问题分析，将脱敏证据存入 project/docs/evidence/rea。避免全局安装、改动 Codex 配置和保存浏览器会话秘密。

官方资料：
- https://github.com/morluto/rea/blob/main/docs/browser-observation.md
- https://github.com/morluto/rea/blob/main/docs/website-script-export.md
- https://github.com/morluto/rea/blob/main/docs/website-module-trace.md
- https://github.com/morluto/rea/blob/main/docs/installation.md

复评触发：仅 UI 观察无法解释的复杂状态、前端字段校验、路由或模块关系。
