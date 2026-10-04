/**
 * L1 runner 的静态段装配（方案 A，2026-10-04）。
 *
 * ## 为什么需要它
 *
 * 首次真跑 L1 时每条 case 都跑满 200 秒拿不到 `agent_end` ——
 * 根因是**driver 只传了一句极简 systemPrompt**（"你是一个画布创作助手。"），
 * 模型在空画布 + 无规则的环境里对「取消生成」这类话术无所适从，
 * 于是反复探索工具、迟迟不结束。
 *
 * ⭐ 教训：**评测环境必须与被测对象一致**。用一个"看起来差不多"的提示词
 * 跑出来的行为数据**不是被测对象的行为** —— 它测的是「另一个 prompt」。
 *
 * ## ⭐ 直接复用生产 loader，不复刻（实测踩坑后的决定）
 *
 * 最初这里**复刻**了 `renderStatic` 的过滤 + hash 逻辑，结果 hash 全部 mismatch。
 * 根因：生产的 `contentHash` 算的是 **frontmatter 解析后的 `trimmed` body**，
 * 而我算的是**整个文件**（含 frontmatter）。
 *
 * ⇒ 与其复刻并维护两套实现（必然漂移），**直接 import 生产的
 * `prompt-registry.loader.ts`**。它本来就是为「脱离 Nest 独立跑」设计的
 * （文件头注释明写「不 import 任何运行时依赖，好让仓库根的 tsx 直接
 * import 它跑 lint；IO 只出现在 loadRegistry 一处，其余全是纯函数」）⇒ 正是本场景。
 *这也符合 ADR-0009「共享逻辑必须用，不重新实现」。
 *
 * ⚠️ 依赖面代价：eval 模块因此import `apps/server/...` 的文件。
 * 但 **pi-runtime 运行时不会 import 它**（只 L1 runner 这个离线工具用），
 * 不违反 ADR-0001 的分层（分层约束的是运行时依赖图）。
 *
 * ## 方案 A 的边界（⚠️ 必须显式记录在报告里）
 *
 * 本模块绕过**Nest 的 `PiPromptAssembler`**，直接调`loadRegistry` + `renderStatic`：
 *
 * ✅ 能测：规则文本本身对模型行为的影响（改 .md ⇒ baseline 变化）
 * ⛔ **测不到**：Nest 装配层（`P1#5` 尾部追加的任务计划约定、
 *   动态段拼装、`STATIC_BUDGET_CHARS` 截断、静态段/动态段的分工）。
 *
 * ⇒ baseline 报告里**必须显式写「未覆盖装配层」**，否则会有人拿它
 * 论证「装配层没问题」—— 而那恰恰是它没测的。
 * 补齐要靠方案 B（runner 经 Nest跑真实装配）。
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

/** 生产的 registry loader 类型（结构化声明，避免跨包 import 造成的类型解析问题）。 */
interface RegistryEntry {
	id: string;
	version: string;
	order: number;
	group?: string;
	unlessGroup?: string;
	body: string;
	contentHash: string;
}

interface RegistrySnapshot {
	registryVersion: string;
	registryHash: string;
	degraded: boolean;
	entries: RegistryEntry[];
}

/** 生产 loader 里我们用到的三个函数（签名对齐 `prompt-registry.loader.ts`）。 */
interface RegistryLoader {
	loadRegistry(root: string): RegistrySnapshot;
	renderStatic(snapshot: RegistrySnapshot, groups: readonly string[]): string;
	resolveRegistryRoot(env: string | undefined): string;
}

/**
 * ⭐ 按需 import 生产的 loader。
 *
 * 用**动态 import + 绝对路径**的原因：runner 可能跑在容器里（loader 路径不同），
 * 且 `.ts` 扩展名在纯 ESM 下解析不到 —— 由 tsx 之类的 loader 在运行时处理。
 */
async function loadProductionLoader(): Promise<RegistryLoader> {
	// 优先用显式指定（容器 / 仓库根不同）
	const explicit = process.env.PI_EVAL_LOADER_PATH;
	const candidates = [
		...(explicit ? [explicit] : []),
			// 仓库内相对本文件（services/pi-runtime/src/eval/ → 仓库根）。
		// ⚠️ 刻意**不用 `import.meta.url`**：它只存在于 ESM，而本模块要能在
		// CJS 与 ESM 两种产物下都能跑（容器里 `node cli.js` 走 CJS，
		// 本地 tsx 走 ESM）。用 `__dirname` 在 ESM 下会 undefined ⇒
		// 两条路径都试一遍，哪条可用走哪条。
		...(typeof __dirname !== "undefined"
			? [join(__dirname, "../../../../apps/server/dist/agent/pi-runtime/prompt-registry.loader.js")]
			: []),
		...(typeof __dirname !== "undefined"
			? [join(__dirname, "../../../../apps/server/src/agent/pi-runtime/prompt-registry.loader.js")]
			: []),
		"/app/apps/server/dist/agent/pi-runtime/prompt-registry.loader.js",
	];
	const tried: string[] = [];
	for (const path of candidates) {
		tried.push(path);
		try {
			const mod = (await import(path)) as RegistryLoader;
			if (typeof mod.loadRegistry === "function" && typeof mod.renderStatic === "function") {
				return mod;
			}
		} catch {
			// 试下一个
		}
	}
	throw new Error(
		`找不到生产 registry loader（tried: ${tried.join(" | ")}）。` +
			`请设 PI_EVAL_LOADER_PATH 指向 apps/server/dist/agent/pi-runtime/prompt-registry.loader.js，` +
			`或用 tsx 之类的 TS loader 运行本工具。`,
	);
}

export interface StaticPromptResult {
	/** 拼装出的静态段（可直接当 systemPrompt 用）。 */
	prompt: string;
	/** Registry 版本与内容哈希（与 Nest 侧同名指标同值，便于对账）。 */
	registryVersion: string;
	registryHash: string;
	/** 参与装配的 rule id（按 order），报告里标注「本轮测了哪些规则」。 */
	appliedIds: string[];
	/** `loadRegistry` 是否走了降级（目录读不到）。⚠️ degraded 时 prompt 是内嵌回退常量。 */
	degraded: boolean;
	/**
	 * 装配出的字符数（对照 Nest 的 `STATIC_BUDGET_CHARS=3200`）。
	 * ⭐ 方案 A 下这个数**可能与生产不同**：生产还要追加 `P1#5` 的任务计划约定。
	 * 超预算时只在报告里提示，**不阻断**（阻断会让「预算超了」看起来像「模型行为变了」）。
	 */
	chars: number;
}

/**
 * 生产在静态段尾部追加的「任务计划汇报」约定。
 *
 * ⭐ **逐字抄自 `agent.service.ts` 的 `systemPromptWithPlanConvention`**：
 * 方案 A 既然要「测的就是模型看到的那份规则」，漏掉这段尾部约定就等于
 * 测了一个**生产不存在的 prompt** —— 而模型很可能因为没有这条约定
 * 而不输出 ⟦plan⟧ 标记，使相关行为判据失真。
 *
 * ⚠️ 两份副本会漂移：改动生产那段时**必须同步这里**。
 * 兜底：`describeRegistry` 报告里的 `chars` 能侧面暴露漂移
 * （尾部变长/变短 ⇒ 字符数变化），但**不会报错** —— 所以这条要写进
 * 「改提示词必查清单」里。
 */
export const PLAN_CONVENTION_TAIL = `## 任务计划汇报（多步任务时启用）
多步出图/改造任务开工前，先单独一行输出计划标记（会被界面渲染为任务清单，用户可见）：
⟦plan⟧[{"n":1,"title":"起稿"},{"n":2,"title":"配图"}]
每完成一项，单独一行输出：⟦task-done⟧<n>
标记行之外不要解释标记本身；单步简单任务不要输出标记。`;

/**
 * 装配静态段（方案 A）。
 *
 * @param registryRoot `prompt-registry` 目录；缺省用生产 loader 的
 *   `resolveRegistryRoot`（读 `PI_RUNTIME_REGISTRY_ROOT` 等环境变量）。
 * @param groups 与生产一致：`['core','writeTools','genTools']`（`agent.service.ts:945`）
 * @param extraTail 追加在静态段之后的文本。生产传的是 `P1#5` 的任务计划汇报约定；
 *   L1 传同一份，确保「模型看到的规则」与生产一致。⚠️ **这是方案 A 唯一能
 *   触及装配层的地方**（其余如动态段仍测不到）。
 */
export async function loadStaticPromptForEval(options: {
	registryRoot?: string;
	groups?: readonly string[];
	extraTail?: string;
} = {}): Promise<StaticPromptResult> {
	const loader = await loadProductionLoader();
	const groups = options.groups ?? ["core", "writeTools", "genTools"];
	const root = options.registryRoot ?? loader.resolveRegistryRoot(process.env.PI_RUNTIME_REGISTRY_ROOT);
	const snapshot = loader.loadRegistry(root);

	//⚠️ degraded 必须显式记录：降级时 prompt 来自**内嵌回退常量**而非磁盘规则，
	// 那测的就不是「当前规则集」了。报告里要能看到。
	if (snapshot.degraded) {
		console.warn(
			`[eval] ⚠️ registry degraded：读不到 ${root}，本轮用的是**内嵌回退常量**，` +
				`baseline 不代表当前规则集（检查 prompt-registry 是否已挂载）。`,
		);
	}

	const base = loader.renderStatic(snapshot, groups);
	const prompt = options.extraTail ? `${base}\n\n${options.extraTail}` : base;

	return {
		prompt,
		registryVersion: snapshot.registryVersion,
		registryHash: snapshot.registryHash,
		// 过滤后才是「本轮实际生效的规则」—— 与 renderStatic 的过滤语义同源。
		appliedIds: [...snapshot.entries]
			.sort((a, b) => a.order - b.order)
			.filter((e) => {
				if (e.group) return groups.includes(e.group);
				if (!groups.includes("core")) return false;
				if (e.unlessGroup && groups.includes(e.unlessGroup)) return false;
				return true;
			})
			.map((e) => e.id),
		degraded: snapshot.degraded,
		chars: prompt.length,
	};
}
