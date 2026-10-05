/**
 * 反哺抑制表 —— Nest 侧（spec2026-10-04-prompt-engineering-design.md §13.3 第 3 条，M6a）。
 *
 * 与 `services/pi-runtime/src/tools/memory.ts` 里的同名机制**刻意各存一份**，
 * 这不是重复劳动，是当前部署形态下的硬约束（改动前请先读完这段）：
 *
 *   - Nest（`apps/server`，CommonJS，K3s Deployment `api`）与
 *     pi-runtime（`services/pi-runtime`，ESM，独立 K3s 部署）是**两个独立进程**。
 *   - 模块级`Map` 只在**本进程**内可见。Nest 侧 import 不到 pi-runtime 的源码：
 *     `apps/server/tsconfig.json` 的 `rootDir: "src"` 收不进 `src/` 外的文件，且两者模块系统不同
 *     （CommonJS vs ESM）；反向也被 `services/pi-runtime/src/independence.test.ts`
 *     明令禁止（pi-runtime 必须零 workspace 依赖，否则物理拆仓时要重新劈）。
 *   - 因此「共享同一张抑制表」在当前形态下**做不到**，除非把表落DB或新增一条同步通道——
 *     两者都超出 M6a 范围（落库已被拍板为不做：抑制是临时止血，不是永久删除）。
 *
 * ⚠️ **已知局限（留给下一个人的真话）**：两侧的表**不会自动同步**。
 * 在pi-runtime 里标记的 id，Nest 侧查不到；反之亦然。
 * 所以当前阶段注入侧的过滤只在「Nest 侧自己标记过」的范围内生效。
 * 收敛这个缺口属于 M6b（晋升/抑制的**判定与标记**归谁）的设计范围——
 * 那时才需要回答「谁持有抑制决策、怎么广播给另一个进程」。本任务只交付**剔除能力**，
 * 不交付标记链路（规格 §13.3 明确 M6a 只做剔除、不做晋升）。
 *
 * 为什么这张表值得存在：记忆是**每轮自动注入**（见 agent.service.ts 的 memoryBlock 拼装，
 * `scope:'any'`、不经模型调用），且记忆池**只增不减**（无 TTL / 无去重 / 无删除）。
 * 一条反复把模型带偏的记忆会每轮重新污染 system prompt，而模型看不到「这条已被证明有害」。
 */
const SUPPRESSED_MEMORY_IDS = new Map<string, string>();

/**
 * 该记忆是否已被反哺抑制。
 *
 * ⚠️ **`memoryId` 为空（条目无 id）时必须返回 false**，即 fail-open：
 * 抑制判据是「这条记忆的 id 被证明有害」，没有 id 就无法证明「这条」就是「那条」。
 * 此时删它等于凭内容猜，而记忆内容恰恰是不可信输入（可能来自跨画布污染）。
 * 代价不对称：误删一条好记忆的代价（用户丢失真实偏好/项目事实，且**无自愈**——
 * 无 TTL、无删除、无提示）远高于漏删一条坏记忆的代价（多污染一轮，下次抑制判据仍会命中它）。
 */
export function isSuppressed(memoryId: string | undefined | null): boolean {
	if (!memoryId) return false;
	return SUPPRESSED_MEMORY_IDS.has(memoryId);
}

/**
 * 标记一条记忆为「反复致错」，后续注入时剔除。附原因仅供排障追溯（当前不外露为接口）。
 *
 * 幂等：同一条重复标记不改变计数也不改变语义——抑制表是集合，不是日志。
 *
 * ⚠️ **当前状态：有代码、无效果。** 与 pi-runtime 侧同款：本函数**没有任何生产调用方**
 *   （已全仓 python os.walk 复核，非 git grep——本仓 git grep 会静默失败）。
 *   所以注入侧的剔除在生产里**永不生效**：每轮注入仍会带上被标记的记忆。
 *   本仓**刻意不加临时标记入口**（例如把某个调试开关接到这条路径上）——
 *   那是给生产加一个没人用的开关，比「留空但写清楚」更糟：
 *   后者会让人知道链路没通，前者会让人误以为已经在拦污染。
 *   标记入口归 M6b（需一并决定跨进程广播方式，见本文件顶部）。
 */
export function markSuppressed(memoryId: string, reason: string): void {
	if (!memoryId) return;
	SUPPRESSED_MEMORY_IDS.set(memoryId, reason);
}