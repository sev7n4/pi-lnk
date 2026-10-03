# ADR-0003: 提示词走注册表资产，禁止硬编码

| 字段 | 值 |
|---|---|
| 状态 | Accepted |
| 日期 | 2026-10-02（PR #114） |
| 决策者 | 项目发起人 |

## 背景

提示词原本是 TS 常量（`prompt-registry.fallback.ts` 里的一堆导出字符串）。问题：

1. **看不见**：线上跑的是哪版提示词，只能登机器翻dist
2. **改不动**：加一条规则要改代码、走完整发布流程
3. **静默降级**：容器构建时若规则文件没进镜像，会**悄悄退回兜底常量**，没人发现
4. **预算失控**：静态段字符数没有硬上限，规则越加越多，最终撑爆 system prompt

## 考虑过的方案

| 方案 | 优点 | 缺点 | 为什么没选 |
|---|---|---|---|
| 继续用 TS 常量 | 无额外管线 | 上面4 个问题全在 | ❌ |
| **`.md` 资产 + MANIFEST + loader（选中）** | 可读、可 diff、进镜像、可门禁 | 需要构建链路保证文件到位 | ✅ |
| 用数据库存 | 运行时可改 | 失去版本控制与 review | ❌ |

## 决定

1. **规则落成 `.md` 资产**：`prompt-registry/rules/*.md`，
   `MANIFEST.yaml` 登记（组、顺序、字符预算）。
2. **loader 薄且无依赖**：`prompt-registry.loader.ts` 只做解析 / 校验 / 版本哈希 / 按组渲染，
   提示词常量抽成**无依赖纯模块**（`prompt-registry.fallback.ts`）供 lint 与运行时兜底共用。
3. **字节等价渲染**：切换到注册表后，渲染结果必须与旧常量**逐字节一致** —— 否则引入注册表本身就改变了行为。
4. **静态段字符预算硬上限**：`STATIC_BUDGET_CHARS = 3200` + 85% 预警线
   （原2400 在加canvas_view_policy 后已被撑破，基线到 2880）。
5. **进镜像 + CI 门禁**：`prompt-registry/**` 必须进 api 镜像（Dockerfile 显式 COPY），
   PR 与master 都有门禁脚本 `scripts/prompt-lint.ts`。
6. **部署后自证**：`GET /api/agent/prompt-registry` 返回 `entryCount` / `degraded` / `registryHash`
   —— 把"线上跑的是哪版"从登机器变成一条 curl。
7. **发版自检必须经 ssh 到 CVM**（PR #118）：自检要取真实容器里的数据，
   必须在 CVM 侧执行；写在 CI runner 上跑会恒失败。

## 后果

**正面**
- 改提示词不用发版，改 `.md` 走 PR 即可
- 线上版本可查（一条 curl）
- 静默降级变成"拦得住"（门禁 + `degraded` 标记）
- 预算有硬线，不会无限膨胀

**负面 / 代价** ❗
- **多了一层构建依赖**：`.md` 没进镜像就会退回兜底 —— 这正是 #116 要解决的问题
- **容器内 `/app/scripts` 不存在**（Dockerfile 只 COPY apps/packages/prompt-registry），
  容器里跑脚本要 import 镜像内已编译的 dist 产物
- 字节等价要求让提示词重构（删词/改词）也需要走完整验证

**将来要注意**
- 加新规则先算预算，别等撞死线
- 提示词**不要**重新硬编码回 TS 常量
- registry 的 fallback 常量与 `.md` 会同时存在，**唯一信息源是 `.md`**，fallback 只是兜底

## 关联

- 资产：`prompt-registry/rules/`、`MANIFEST.yaml`
- loader：`apps/server/src/agent/pi-runtime/prompt-registry.loader.ts`
- 门禁：`scripts/prompt-lint.ts`、`.github/workflows/prompt-lint.yml`
- PR：#114（W1a）、#115（诊断端点）、#116（部署自证）、#118（ssh 自检）
