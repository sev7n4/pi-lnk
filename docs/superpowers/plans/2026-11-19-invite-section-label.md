# 「邀请与设置」文案收敛为「我的邀请码」· 计划

> 对应规格：`docs/superpowers/specs/2026-11-19-invite-section-label-design.md`

## 0. 第一原则
吃满上游、不重复造轮子。本刀全部复用现成文案锚与现成断言，零新增文件/组件/令牌/守卫。等价物检索结论见规格 §0。

## 1. 实施步骤

| # | 步骤 | 产物 / 判据 |
|---|---|---|
| 1 | 开隔离 worktree（已完成） | `chore/invite-section-label` @ `be363f8d` |
| 2 | 写规格 + 计划（本步） | 两份文档落盘 |
| 3 | TDD-RED：改 `ProfilePage.test.ts:329-337` 断言为「我的邀请码」，加反向断言不含「邀请与设置」 | 定向 vitest 转 RED |
| 4 | 实现：改 `ProfilePage.vue:182` summary 文案 | 定向 vitest GREEN |
| 5 | 变异自检：组件文案改回旧值 → 测试 RED → 还原 | 证伪能力确认 |
| 6 | 类型检查 + 前端视觉守卫 + 定向全绿 | `vue-tsc -b`、design-token 等 |
| 7 | 提交 → 推 PR → 盯 CI 全绿 | squash 合并 |
| 8 | web-only 部署 → 生产 CDP 走查文案 | 线上 DOM 命中「我的邀请码」 |
| 9 | 清理 worktree/分支 + 工作日志 | 收尾 |

## 2. 环境判据（本机）
- vitest：nvm node24 + `--maxWorkers=1 --no-file-parallelism`。
- `vue-tsc -b` 勿加 `--noEmit`；pnpm 须 `env -u NODE_OPTIONS`。
- git push 502 时走 gh api REST：blob（`-F content=@file`）→ tree（base_tree + 改动路径）→ commit → ref → PR。
- 合并最强证据：合并树 == CI 验证 head 树。
- 部署：push 触发 deploy 自动分流 web-only；判据 = 产物 chunk 含新文案。
- 生产 CDP：headless + 单会话，导航 `/profile`，读折叠区 summary 文本。

## 3. 风险与边界
- 改动极小，主要风险是测试断言漏改导致 CI 假绿/真红——靠变异自检兜底。
- 不触碰主仓脏工作区（当前在 `docs/task-planning-roadmap` 分支，全程只读）。

## 4. 完成定义
见规格 §7。全部满足才宣告收口，不提前宣告 ALL_PASS。
