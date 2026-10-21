/**
 * 画布分组的 zod 契约（2026-10-21，Agent 分组工具落地的契约层）。
 *
 * ## 为什么单独一个文件
 *
 * 背景：Agent 要自主调用「打组 / 拆组 / 分组背景色」，但这三条链路当时缺三样东西 ——
 * ① `CanvasGroup` 只有 TS interface（在 `index.ts`），**没有运行时 schema**，
 *    而 Nest 侧 DTO 靠 class-validator、工具侧靠 TypeBox，三处各写各的；
 * ② 色卡 8 键只定义在前端 `apps/web/src/components/canvas/groupColors.ts`，
 *    服务端 `setGroupColor` **完全不校验** colorKey（DTO 是自由 `string | null`）
 *    ⇒ 写进去一个 `'hacker666'`，前端 `normalizeGroupColorKey` 静默落 neutral，
 *    用户表现为「设了没反应」，且服务端没有任何拒绝；
 * ③ `summarizeGroups` 只返回 `{id,title,childIds}`，**不含 colorKey**，
 *    Agent 读得到「有哪些组」却读不到「组是什么颜色」。
 *
 * 本文件把这三件事收敛到一处：色键白名单下沉为 SSOT、给出 `CanvasGroup` 的运行时
 * schema、给出三个请求体 schema 供 Nest DTO 与工具参数共用。
 *
 * ## 分组为什么不是节点（别把它塞回 NODE_TYPES）
 *
 * `group` 节点已于 2026-10-19 下线（见 `agentContract.ts` 的 NODE_TYPES 注释）：
 * 分组现在是 `CanvasData.groups` 侧车，不占节点位、不进 agent 节点白名单。
 * 所以 Agent 侧**不能**用 `add_node` 建组，必须走本文件描述的显式命令 ——
 * 这是设计决定，不是能力缺失。
 */
import { z } from 'zod'

// ============================================================
// 色卡白名单（SSOT）
// ============================================================

/**
 * 分组色卡 8 键。色值本体在 `design-tokens.css` 的 `--lnk-group-{key}`
 * （两主题成对定义），本文件只管**键**。
 *
 * ⭐ 下沉理由（2026-10-21）：此前只存在于前端 `groupColors.ts`，导致服务端
 * `setGroupColor` 无从校验 —— Agent 能写入任意字符串，失败发生在很远的
 * 前端渲染层且**静默**（落 neutral）。白名单必须在**写入口**（服务端）
 * 就拒掉，而不是在渲染层兜底。
 *
 * 与前端的关系：`apps/web/src/components/canvas/groupColors.ts` 的
 * `GROUP_COLOR_KEYS` 已改为从这里 re-export，不再自有副本。
 */
export const GROUP_COLOR_KEYS = [
  'neutral',
  'moss',
  'dusk',
  'clay',
  'celadon',
  'graphite',
  'rose',
  'plum',
] as const

export type GroupColorKey = (typeof GROUP_COLOR_KEYS)[number]

/** 缺省色键（中性灰刻意避开品牌紫，理由见 groupColors.ts）。 */
export const DEFAULT_GROUP_COLOR_KEY: GroupColorKey = 'neutral'

export const GroupColorKeySchema = z.enum(GROUP_COLOR_KEYS)

/**
 * 宽松解析：非法值落 `null`（= 复位默认色），**不**落 neutral。
 *
 * 与前端 `normalizeGroupColorKey`（非法 → neutral）语义**故意不同**：
 * 前端要「无论如何都能画」，所以兜底成合法色；这里要「让调用方知道没写对」，
 * 所以返回 null 由上层决定是报错还是复位。
 */
export function parseGroupColorKey(raw: unknown): GroupColorKey | null {
  return typeof raw === 'string' && (GROUP_COLOR_KEYS as readonly string[]).includes(raw)
    ? (raw as GroupColorKey)
    : null
}

// ============================================================
// CanvasGroup schema
// ============================================================

/** 画布绝对坐标下的点 / 尺寸。 */
export const GroupRectSchema = z.object({
  x: z.number(),
  y: z.number(),
})

export const GroupSizeSchema = z.object({
  width: z.number(),
  height: z.number(),
})

/**
 * 分组（`CanvasData.groups` 侧车结构）的运行时 schema。
 *
 * 与 `index.ts` 的 `CanvasGroup` interface 同形 —— 刻意**两份并存**：
 * interface 给 TS 静态用（本 barrel 是类型 SSOT），schema 给运行时用。
 * `canvasGroup.contract.test.ts` 会断言两者字段逐一对应，防漂移。
 */
export const CanvasGroupSchema = z.object({
  id: z.string(),
  title: z.string(),
  colorKey: GroupColorKeySchema.optional(),
  childIds: z.array(z.string()),
  position: GroupRectSchema,
  size: GroupSizeSchema,
})

export type CanvasGroupParsed = z.infer<typeof CanvasGroupSchema>

// ============================================================
// 三个命令的请求体（Agent 工具 → Nest 端点 契约）
// ============================================================

/** 打组：≥2 个未分组节点才成立（服务端 `createGroupFromSelection` 判）。 */
export const GroupNodesRequestSchema = z.object({
  sessionId: z.string(),
  userId: z.string(),
  nodeIds: z.array(z.string()).min(2, '至少需要 2 个节点才能打组'),
  title: z.string().optional(),
})

/** 拆组：只移除分组框，子节点保持原坐标。 */
export const UngroupNodeRequestSchema = z.object({
  sessionId: z.string(),
  userId: z.string(),
  groupId: z.string(),
})

/**
 * 分组背景色。`colorKey` 允许 `null`（复位默认色），
 * ⛔ 但**非空时必须是 8 键之一** —— 这正是本文件要修的缺口。
 */
export const SetGroupColorRequestSchema = z.object({
  sessionId: z.string(),
  userId: z.string(),
  groupId: z.string(),
  colorKey: GroupColorKeySchema.nullish(),
})

export type GroupNodesRequest = z.infer<typeof GroupNodesRequestSchema>
export type UngroupNodeRequest = z.infer<typeof UngroupNodeRequestSchema>
export type SetGroupColorRequest = z.infer<typeof SetGroupColorRequestSchema>

// ============================================================
// 给 Agent 读的分组摘要（读工具回包）
// ============================================================

/**
 * `get_canvas_layout` 回包里每个分组的摘要形态。
 *
 * 2026-10-21 起**带 `colorKey`** —— 此前只返回 `{id,title,childIds}`，
 * Agent 读得到组的存在却读不到颜色，于是「把这个蓝框改成红色」这类指令
 * 无法落地（既不知道哪个组是蓝的，也不知道改完是什么色）。
 */
export const CanvasGroupSummarySchema = z.object({
  id: z.string(),
  title: z.string(),
  childIds: z.array(z.string()),
  colorKey: GroupColorKeySchema.optional(),
})

export type CanvasGroupSummary = z.infer<typeof CanvasGroupSummarySchema>