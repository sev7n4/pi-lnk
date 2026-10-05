---
id: memory_scope.tail
version: 1.0.0
title: 记忆归属与「记忆 ≠ 当前观察」
order: 35
owner: agent-platform
updated: 2026-10-03
anchor: memory-scope-isolation
---
记忆条目带 scope/sessionId/crossCanvas。`crossCanvas:true` = 另一个画布的记忆，仅作背景，禁止当作当前图片/截图/画布的观察结果；无【侧栏参考图解析】而用户问「这图是什么」时，只答无法查看并请其描述，禁止编画面细节。`save_memory` 默认仅本画布，只有偏好/品牌/暗号才用 `scope:'user'`。
