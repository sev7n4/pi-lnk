/**
 * prompt-registry 薄 loader：解析、校验、算版本身份、按组渲染。
 *
 * 设计约束（Review Focus 第 5 条）：本文件**不 import 任何运行时依赖**
 * （不 import @nestjs/common、不 import assembler），好让仓库根的 tsx
 * 直接 import 它跑 lint；IO 只出现在 loadRegistry 一处，其余全是纯函数。
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  CANVAS_VIEW_POLICY,
  CANVAS_DAILY_OPS,
  CORE_RULES_PREFIX,
  GEN_TOOLS_RULES,
  RULE_3_GEN,
  RULE_3_NO_GEN,
  RULE_10_WRITE_GUARD,
  CORE_RULES_TAIL,
  MEMORY_SCOPE_RULES,
  WRITE_TOOLS_RULES,
} from "./prompt-registry.fallback";

/** L4 白名单：group / unlessGroup 出现未知值即报错。 */
const GROUP_VALUES = new Set<string>(["writeTools", "genTools"]);

/**
 * L6 静态段字符预算：硬上限，超过即 lint 失败。
 *
 * 2400 是 2026-10-02 定下的（design doc §L6：定限时全组合实测 1925，故意留 475 余量）。
 * 此后 memory_scope.tail / gen_tool_policy 等规则陆续加入，基线全组合被推到 2333（只剩 67 余量），
 * 2026-10-03 加 canvas_view_policy（546字符）后全组合 2880 ⇒ 旧上限已无法容纳任何新规则。
 * 上调到 3200：距当前 2880 留约 320 字符（约 4 条中等规则），并配STATIC_BUDGET_WARN_CHARS
 * 预警线，让「快满了」在撞死线之前就先被看见。
 */
export const STATIC_BUDGET_CHARS = 3200;

/** L6 预警线：预算的 85%（design doc §L6「≥ N 报错前先警告并登记」——该分支直到2026-10-03 才补上实现）。 */
export const STATIC_BUDGET_WARN_CHARS = Math.floor(STATIC_BUDGET_CHARS * 0.85); // 2720

/** L6 预算校验的常见组合：预警与硬报错共用同一份，避免两处漂移。 */
const BUDGET_COMBOS: readonly (readonly string[])[] = [
  ["core"], ["core", "writeTools"], ["core", "genTools"], ["core", "writeTools", "genTools"],
];

const REQUIRED_FIELDS = ["id", "version", "title", "order", "owner", "updated", "anchor"] as const;

/**
 * anchor 的**唯一字符集契约**：L11 校验它、L10 按它扫描引用。
 *
 * 为什么要共用一个常量（而不是两处各写一套正则）：两者是**同一条契约的两端**。
 * L10 只扫「小写字母开头 + 小写字母数字连字符 + 至少 4 字符」，若 L11 放行别的形态，
 * 就会出现「anchor 存在但引用扫不到」⇒ L10 静默绿、断链无告警（本任务要消灭的那类失效）。
 * 派生式写法让「改了一处忘了另一处」这个失效模式在结构上不成立。
 *
 * ⚠️ 反方向（放宽 L10 去匹配任意字符）是错的：会让 L10 去扫工具名（`upsert_media_node`）重新误报，
 *违反 spec §7.3「零误报」。**收紧 L11 是唯一正确方向。**
 */
export const ANCHOR_CHARSET = /^[a-z][a-z0-9-]{3,}$/;

/**
 * ANCHOR_CHARSET 的**句中形态**：剥掉 `^`/`$` 行锚点，只留字符集本体，供 L10 嵌进扫描正则。
 *
 * ⚠️ 这层剥离不是洁癖：把 `^[a-z][a-z0-9-]{3,}$` 直接嵌进「见 \`…\`」的句中模式，
 * 捕获组里会带 `^…$` 行锚点，**在句中永不匹配** ⇒ 实测 L10 对真实文案 `false`（判据静默空转）。
 * 保留行锚点版给 L11 做整串校验、剥锚点版给 L10 做句中扫描，两者共用同一份字符集定义。
 *
 * ⚠️ 导出是为了让测试能直接断言「生产两侧派生一致」（同源契约的**唯一真实防线**）。
 * 此前这条契约没有任何测试覆盖——测试里另写了一份副本，副本与生产是否一致无人把关。
 */
export const ANCHOR_CHARSET_IN_TEXT = ANCHOR_CHARSET.source.replace(/^\^/, "").replace(/\$$/, "");

export interface PromptRegistryEntry {
  id: string; version: string; title: string; order: number;
  group?: string; unlessGroup?: string;
  owner: string; updated: string;
  /**
   * L10/L11 语义短名（规则自己的稳定标识，非它引用的目标）。
   *
   * **刻意可选**：本接口被测试与调用方大量手工构造（字面量），设为必填会连带一片编译失败。
   * 缺失只影响规则地图的「语义 id」列显示为空串，不影响 L0–L11任何判据。
   */
  anchor?: string;
  body: string;
  contentHash: string;
}

export interface PromptRegistrySnapshot {
  registryVersion: string;
  registryHash: string;
  entries: PromptRegistryEntry[];
  degraded: boolean;
  degradedReason?: string;
  /**
   * 非致命信号（当前只有 L6 预算预警）。与 degraded 同级：只登记、不阻断——
   * errors 为空即视为通过，warnings 不进数组，故不会让 lint/测试变红。
   * 通道= describeRegistry() 的一行摘要（启动日志），由 loadRegistry() 填充。
   * ⚠️ **不要往外端点透出**：免鉴端点 /api/agent/prompt-registry 的安全边界是响应字段本身，
   * 其字段白名单被 prompt-registry-diag.test.ts 锁死。
   */
  warnings?: string[];
}

/** L9：代码侧声明的、必须由 Registry 提供的 id 清单。 */
export const COMPOSED_IDS = [
  "identity.opening", "no_gen_claim.nogen", "no_gen_claim.gen", "sidebar_vision.tail",
  "memory_scope.tail", "media_tool_policy", "canvas_view_policy", "canvas_daily_ops",
  "gen_tool_policy", "write_guard",
] as const;

/** L7：Registry id → fallback 常量的映射。 */
export const FALLBACK_BY_ID: Record<string, string> = {
  "identity.opening": CORE_RULES_PREFIX,
  "no_gen_claim.nogen": RULE_3_NO_GEN,
  "no_gen_claim.gen": RULE_3_GEN,
  "sidebar_vision.tail": CORE_RULES_TAIL,
  "memory_scope.tail": MEMORY_SCOPE_RULES,
  "media_tool_policy": WRITE_TOOLS_RULES,
  "canvas_view_policy": CANVAS_VIEW_POLICY,
  "canvas_daily_ops": CANVAS_DAILY_OPS,
  "gen_tool_policy": GEN_TOOLS_RULES,
  "write_guard": RULE_10_WRITE_GUARD,
};

/** 与 vendor 的 prompt-templates.ts 同族分隔符：首行 --- 起，终止于 \n---。 */
export function parseFrontmatter(text: string): { fields: Record<string, string>; body: string } {
  if (!text.startsWith("---")) return { fields: {}, body: text.replace(/^\n/, "") };
  const end = text.indexOf("\n---", 3);
  if (end === -1) throw new Error("frontmatter 缺少终止分隔符 \\n---");
  const fields = parseFlatYaml(text.slice(3, end));
  const body = text.slice(end + 4).replace(/^\n/, "").replace(/\n$/, "");
  return { fields, body };
}

/** 只认扁平 `key: value`（含引号剥离）；不支持嵌套、列表、块标量。 */
function parseFlatYaml(raw: string): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const i = t.indexOf(":");
    if (i === -1) continue;
    let value = t.slice(i + 1).trim();
    if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
      value = value.slice(1, -1);
    }
    fields[t.slice(0, i).trim()] = value;
  }
  if (Object.keys(fields).length === 0) throw new Error("frontmatter 为空或不是扁平键值");
  return fields;
}

/** 单件内容哈希：sha256(body) 前 12 位 hex。 */
export function contentHash(body: string): string {
  return createHash("sha256").update(body, "utf8").digest("hex").slice(0, 12);
}

/** 规范化清单：按 order 升序（同 order 用 id 稳定兜底），条目为 id@version#contentHash。 */
export function normalizeManifest(entries: PromptRegistryEntry[]): string {
  return [...entries]
    .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id))
    .map((e) => `${e.id}@${e.version}#${e.contentHash}`)
    .join("\n");
}

export function registryHashOf(entries: PromptRegistryEntry[]): string {
  return contentHash(normalizeManifest(entries));
}

export interface ManifestEntry { id: string; version: string; order: number; contentHash: string; }

/** 按 `- id:` 分块读 MANIFEST（每个条目是独立块，不能用扁平解析，否则会互相覆盖）。 */
export function parseManifest(text: string): ManifestEntry[] {
  const out: ManifestEntry[] = [];
  let cur: ManifestEntry | null = null;
  for (const line of text.split("\n")) {
    const head = line.match(/^\s*-\s+id:\s*(\S+)\s*$/);
    if (head) {
      cur = { id: head[1], version: "", order: 0, contentHash: "" };
      out.push(cur);
      continue;
    }
    const kv = line.match(/^\s+(version|order|contentHash):\s*(\S+)\s*$/);
    if (kv && cur) {
      if (kv[1] === "version") cur.version = kv[2];
      if (kv[1] === "contentHash") cur.contentHash = kv[2];
    }
  }
  return out;
}

/** 容器三级解析：显式 env → 容器内 /app/prompt-registry → 从 cwd 向上找。 */
export function resolveRegistryRoot(): string {
  if (process.env.PI_PROMPT_REGISTRY_DIR) return process.env.PI_PROMPT_REGISTRY_DIR;
  if (existsSync("/app/prompt-registry/rules")) return "/app/prompt-registry";
  let dir = resolve(process.cwd());
  for (let i = 0; i < 6; i += 1) {
    if (existsSync(join(dir, "prompt-registry", "rules"))) return join(dir, "prompt-registry");
    const parent = resolve(dir, "..");
    if (parent === dir) break;
    dir = parent;
  }
  return join(process.cwd(), "prompt-registry");
}

/** 读盘 + 校验 + 算版本；失败不抛，走 degraded 语义（运行时 fail-soft）。 */
export function loadRegistry(root: string): PromptRegistrySnapshot {
  const empty = (reason: string): PromptRegistrySnapshot => ({
    registryVersion: "", registryHash: contentHash(""), entries: [], degraded: true, degradedReason: reason, warnings: [],
  });
  try {
    const rulesDir = join(root, "rules");
    const files = readdirSync(rulesDir).filter((f) => f.endsWith(".md")).sort();
    const entries: PromptRegistryEntry[] = [];
    for (const file of files) {
      const { fields, body } = parseFrontmatter(readFileSync(join(rulesDir, file), "utf8"));
      entries.push({
        id: fields.id, version: fields.version, title: fields.title, order: Number(fields.order),
        group: fields.group, unlessGroup: fields.unlessGroup,
        owner: fields.owner, updated: fields.updated, anchor: fields.anchor,
        body: body.trimEnd(), contentHash: contentHash(body.trimEnd()),
      });
    }
    // 目录在但一条规则都没有 ⇒ 与「读不到」同判据：空静态段比降级更危险（system prompt 会变空）。
    if (entries.length === 0) return empty(`${rulesDir} 下没有任何 .md 规则文件`);
    const manifestPath = join(root, "MANIFEST.yaml");
    const registryVersion = existsSync(manifestPath)
      ? (parseFlatYaml(readFileSync(manifestPath, "utf8")).version ?? "")
      : "";
    // 预算预警走 warnings（只登记不阻断）：静态段超预警线不影响正确性，
    // 但余量耗尽前值得被看见——这是它唯一该出现的地方。
    const { warnings } = checkRegistryIntegrity(root);
    return { registryVersion, registryHash: registryHashOf(entries), entries, degraded: false, warnings };
  } catch (err) {
    return empty(err instanceof Error ? err.message : String(err));
  }
}

/** 按组渲染静态段；与搬家前的 composeRuleText() 逐字节等价（spec §4.4）。 */
export function renderStatic(snapshot: PromptRegistrySnapshot, groups: readonly string[]): string {
  const coreOn = groups.includes("core");
  return [...snapshot.entries]
    .sort((a, b) => a.order - b.order)
    .filter((e) => {
      if (e.group) { if (!groups.includes(e.group)) return false; }
      else if (!coreOn) return false;
      if (e.unlessGroup && groups.includes(e.unlessGroup)) return false;
      return true;
    })
    .map((e) => e.body)
    .join("\n");
}

/** fallback 路径：直接用内嵌常量出静态段（容器读不到目录时的退路）。 */
export function renderStaticFallback(groups: readonly string[]): string {
  const coreOn = groups.includes("core");
  const parts: string[] = [];
  if (coreOn) {
    parts.push(groups.includes("genTools")
      ? `${CORE_RULES_PREFIX}\n${RULE_3_GEN}\n${CORE_RULES_TAIL}\n${MEMORY_SCOPE_RULES}`
      : `${CORE_RULES_PREFIX}\n${RULE_3_NO_GEN}\n${CORE_RULES_TAIL}\n${MEMORY_SCOPE_RULES}`);
  }
  // ⚠️ 拼装顺序必须与磁盘 order 一致：canvas_view_policy(order 45) 夹在
  // media_tool_policy(40) 与 gen_tool_policy(50) 之间。漏推任何一条 ⇒ 容器读不到
  // registry 走此退路时该规则**整段消失且无任何报错**（degraded 本身是静默降级），
  // 且长度差恰好等于漏掉规则的 body 字符数，是唯一可测的信号。
  if (groups.includes("writeTools")) parts.push(WRITE_TOOLS_RULES, CANVAS_VIEW_POLICY, CANVAS_DAILY_OPS);
  if (groups.includes("genTools")) parts.push(GEN_TOOLS_RULES);
  if (!groups.includes("writeTools") && coreOn) parts.push(RULE_10_WRITE_GUARD);
  return parts.filter(Boolean).join("\n");
}

/** §3 规则地图「管什么」列的显示宽度上限（超出部分在语义边界收尾并补省略号）。 */
const SUMMARY_MAX = 60;

/**
 * 首句摘要：截断到语义边界而不是硬切。
 *
 * 硬切（`slice(0, 60)`）会留下「用 upsert_media_node创建或更新节点（「这种悬空括号残句——
 * 它读起来像规则本身写错了，而不是摘要被截断。收尾策略：优先退到 60 字内最后一个
 * 标点/右括号，再回退掉悬空的左括号，最后补 `…` 明示截断。
 */
export function summarize(body: string): string {
  const sentence = body.replace(/\n+/g, " ").trim().split("。")[0]!;
  if (sentence.length <= SUMMARY_MAX) return sentence;
  const head = sentence.slice(0, SUMMARY_MAX);
  const boundary = Math.max(..."，、；：）】》」".split("").map((c) => head.lastIndexOf(c)));
  let cut = boundary > SUMMARY_MAX / 2 ? head.slice(0, boundary) : head;
  // 悬空左括号：左括号数多于右括号，且最后一个左括号在最后一个右括号之后 ⇒ 回退到它之前
  while (cut.includes("（") && cut.split("（").length > cut.split("）").length && cut.lastIndexOf("（") > cut.lastIndexOf("）")) {
    cut = cut.slice(0, cut.lastIndexOf("（"));
  }
  return `${cut.replace(/[\s（(【]+$/, "")}…`;
}

/**
 * PromptRegistryEntry[] → 规则地图生成器的输入形态。
 *
 * 为什么需要它：`renderRuleMap` 要的是「anchor + 首句摘要」，而 PromptRegistryEntry
 * 的 body 里没有摘要字段。Task 4的组装管线契约测试手上只有 loadRegistry() 的产物
 * （PromptRegistryEntry[]），走这个转换即可复用同一个 renderRuleMap，不必重读磁盘。
 */
export function toRuleMeta(entries: readonly PromptRegistryEntry[]): RuleMeta[] {
  return entries
    .map((e) => ({
      id: e.id, title: e.title, order: e.order,
      group: e.group, unlessGroup: e.unlessGroup,
      anchor: e.anchor ?? "", firstSentence: summarize(e.body),
    }))
    .sort((a, b) => a.order - b.order);
}

/** 规则地图生成器的输入形态；与 toRuleMeta 的输出同构。 */
export interface RuleMeta { id: string; title: string; order: number; group?: string; unlessGroup?: string; anchor: string; firstSentence: string; }

/** L0-L11 全量校验；返回错误数组，空数组 = 通过（CI 与运行时共用同一份判据）。 */
export function assertRegistryIntegrity(root: string): string[] {
  return checkRegistryIntegrity(root).errors;
}

/**
 * L0-L11 全量校验 + 非致命预警（当前只有 L6 预算预警）。
 *
 * 拆成两个函数而不是给 assertRegistryIntegrity 加返回类型：后者有 11 处调用方
 * （prompt-lint.ts + loader.test.ts 十处），全在按 `string[]` 用，改签名会连带一片。
 * errors 保持"空数组 = 通过"的语义不变，warnings 只登记不阻断。
 */
export function checkRegistryIntegrity(root: string): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const budgetWarnings: string[] = [];
  const add = (code: string, msg: string) => errors.push(`${code} ${msg}`);
  try {
    const rulesDir = join(root, "rules");
    const files = readdirSync(rulesDir).filter((f) => f.endsWith(".md")).sort();
    if (files.length === 0) add("L0", `${rulesDir} 下没有 .md`);
    const seen = new Map<string, PromptRegistryEntry>();
    const anchorSeen = new Map<string, string>();
    for (const file of files) {
      const path = join(rulesDir, file);
      let fields: Record<string, string>;
      let body: string;
      try {
        ({ fields, body } = parseFrontmatter(readFileSync(path, "utf8")));
      } catch (err) {
        add("L1", `${file} frontmatter 解析失败：${err instanceof Error ? err.message : String(err)}`);
        continue;
      }
      for (const key of REQUIRED_FIELDS) {
        if (!fields[key]) add("L1", `${file} 缺必填字段 ${key}`);
      }
      if (fields.id !== file.replace(/\.md$/, "")) add("L2", `${file} 的 id(${fields.id}) 与文件名不一致`);
      if (seen.has(fields.id)) add("L2", `id ${fields.id} 重复（${seen.get(fields.id)?.id ?? file} 与 ${file}）`);
      // L11：anchor 是 L10 语义引用的目标标识，必须存在、唯一、且字符集合规。
      // 缺了 ⇒ 引用扫不到目标、无人报错；重了 ⇒ 引用指向哪条产生歧义。
      // ⚠️ 字符集这条堵的是**假绿通道**：L10 的扫描正则只认「小写字母+连字符」，若 L11 不校验字符集，
      // anchor 写成 `Gen_Confirm` / `gen_confirm` / `gen.confirm` / 中文时，正文里 `见 \`Gen_Confirm\``
      // 扫不到 ⇒ L10 静默绿、断链无告警（恰是 L10 要消灭的那类失效）。收紧 L11 让它在**写入时** fail fast。
      // ⚠️ 不要改成「放宽 L10 去匹配任意字符」——那会让 L10 去扫工具名（upsert_media_node）重新误报。
      if (!fields.anchor) add("L11", `${file} 缺 anchor 字段（L10 语义引用靠它定位）`);
      else if (!ANCHOR_CHARSET.test(fields.anchor)) {
        add("L11", `${file} 的 anchor「${fields.anchor}」不合规：必须是 /^[a-z][a-z0-9-]{3,}$/（L10 只扫「见 \`<anchor>\`」，不合规的 anchor 会让引用扫不到、断链无告警）`);
      } else if (anchorSeen.has(fields.anchor)) add("L11", `anchor ${fields.anchor} 重复（${anchorSeen.get(fields.anchor)} 与 ${file}）`);
      else anchorSeen.set(fields.anchor, file);
      for (const key of ["group", "unlessGroup"] as const) {
        const v = fields[key];
        if (v && !GROUP_VALUES.has(v)) add("L4", `${file} 的 ${key}=${v} 不在白名单 [${[...GROUP_VALUES].join(",")}]`);
      }
      const raw = readFileSync(path, "utf8");
      // L5：文件末尾只允许「body + 恰好一个换行」；多出来的空行会让 trimEnd 约定失效。
      if (/\n[ \t]*$/.test(raw.slice(0, -1))) {
        add("L5", `${file} body 后有尾随空行（约定：body 之后最多一个换行）`);
      }
      if (/<[A-Za-z][^>]*>/.test(body)) add("L5", `${file} body 含裸尖括号标签，会进 CDATA 吞掉上下文`);
      const trimmed = body.trimEnd();
      if (COMPOSED_IDS.includes(fields.id as (typeof COMPOSED_IDS)[number])
        && FALLBACK_BY_ID[fields.id] !== undefined && FALLBACK_BY_ID[fields.id] !== trimmed) {
        add("L7", `${file} 的 body 与 prompt-registry.fallback.ts 的 ${fields.id} 常量不一致`);
      }
      seen.set(fields.id, { id: fields.id, version: fields.version, title: fields.title,
        order: Number(fields.order), group: fields.group, unlessGroup: fields.unlessGroup,
        owner: fields.owner, updated: fields.updated, anchor: fields.anchor,
        body: trimmed, contentHash: contentHash(trimmed) });
    }
    // L10：规则正文里的「见 `<anchor>`」引用必须指向真实存在的 anchor。
    // 语义在短名里而不在编号里 ⇒ 编号重排/插入不再静默断链（spec §7.3）。
    // ⚠️ 正则三处细节都是被真实文本逼出来的，改任一条都会让判据失效：
    //   ① `?` 反引号可选：磁盘上真实引用写作「见 `anchor`」，写成必选会把它们全扫漏 ⇒ L10 永远绿。
    //   ② 右边界否定断言：否则「禁止见 upsert_media_node」会截出 'upsert' 误报（spec §7.3 要求零误报）。
    //   ③ 捕获组字符集**由 ANCHOR_CHARSET 派生**（不各写一套）：L11 用它校验 anchor 合法性，
    //      L10 用它扫描引用 ⇒ 两者契约闭合，不存在「anchor 合规但 L10 扫不到」的组合。
    //      [a-z0-9-] 不含下划线且首字符必须字母：「见规则 14」「见生成确认门」不匹配（中文天然被排除）。
    // 数字引用（「见规则 14」）的迁移已随 Task 3 改 body 完成；本判据只认语义 anchor。
    const ANCHOR_REF = new RegExp(String.raw`见\s*` + "`" + String.raw`?(${ANCHOR_CHARSET_IN_TEXT})(?![A-Za-z0-9_-])`, "g");
    // seen 的键是 id（不是文件名）；L2 已保证 id === 文件名去 .md，故报错信息与其它判据同形。
    for (const [id, entry] of seen) {
      for (const m of entry.body.matchAll(ANCHOR_REF)) {
        const ref = m[1]!;
        if (!anchorSeen.has(ref)) add("L10", `${id} 引用了不存在的 anchor「${ref}」`);
      }
    }
    // L8 / L3：MANIFEST 是登记处，同时充当 L3「内容相对基线是否变了」的基线快照
    const manifestPath = join(root, "MANIFEST.yaml");
    const manifestText = existsSync(manifestPath) ? readFileSync(manifestPath, "utf8") : "";
    const declared = parseManifest(manifestText);
    const byId = new Map(declared.map((e) => [e.id, e]));
    if (!existsSync(manifestPath)) {
      add("L8", `${root}/MANIFEST.yaml 不存在`);
    } else {
      const top = parseFlatYaml(manifestText);
      if (!/^\d+\.\d+\.\d+$/.test(top.version ?? "")) {
        add("L8", `MANIFEST.yaml 的 version(${top.version ?? ""}) 不是 MAJOR.MINOR.PATCH`);
      }
      for (const [id, e] of seen) {
        const d = byId.get(id);
        if (!d) { add("L8", `${id} 未在 MANIFEST.yaml 登记`); continue; }
        // L3：body 相对基线变了却没同步 version + contentHash → 拦下
        if (d.contentHash && d.contentHash !== e.contentHash) {
          add("L3", `${id} 的 body 已变（磁盘 ${e.contentHash} ≠ 登记 ${d.contentHash}）：请 bump 该条 version 并同步 MANIFEST 里的 contentHash`);
        }
        if (d.version !== e.version) {
          add("L8", `${id} 的 MANIFEST version(${d.version}) 与 frontmatter(${e.version}) 不一致`);
        }
      }
      for (const d of declared) if (!seen.has(d.id)) add("L8", `MANIFEST.yaml 登记的 ${d.id} 没有对应 .md 文件`);
    }
    // L9：代码声明的 id 必须都在 Registry 里
    for (const id of COMPOSED_IDS) if (!seen.has(id)) add("L9", `代码声明引用的 id ${id} 不在 Registry 中`);
    // L6：预算（恒注入 + 常见组合 ≤ STATIC_BUDGET_CHARS）。
    // ⚠️ 判据处必须用常量 + BUDGET_COMBOS：写死数字会让「上调预算」变成纯注释，
    // 常量零消费点而 lint 照红（2026-10-03 实测）。超预警线但未超硬线 ⇒ 登记 warnings 不阻断。
    const snap = { registryVersion: "", registryHash: "", entries: [...seen.values()], degraded: false };
    for (const combo of BUDGET_COMBOS) {
      const n = renderStatic(snap, combo).length;
      if (n > STATIC_BUDGET_CHARS) {
        add("L6", `组合 ${combo.join("+")} 静态段 ${n} 字符，超过预算 ${STATIC_BUDGET_CHARS}`);
      } else if (n >= STATIC_BUDGET_WARN_CHARS) {
        budgetWarnings.push(`L6 组合 ${combo.join("+")} 静态段 ${n} 字符，已过预警线 ${STATIC_BUDGET_WARN_CHARS}（硬线 ${STATIC_BUDGET_CHARS}，余量 ${STATIC_BUDGET_CHARS - n}）`);
      }
    }
    return { errors, warnings: budgetWarnings };
  } catch (err) {
    return { errors: [`L0 无法读取 Registry：${err instanceof Error ? err.message : String(err)}`], warnings: [] };
  }
}

/** 人类可读的一行版本摘要，供启动日志与 manifest 行使用。 */
export function describeRegistry(snapshot: PromptRegistrySnapshot): string {
  const warn = snapshot.warnings?.length ? ` warnings=${snapshot.warnings.length}[${snapshot.warnings.join(" | ")}]` : "";
  return `prompt registry version=${snapshot.registryVersion} hash=${snapshot.registryHash} entries=${snapshot.entries.length} degraded=${snapshot.degraded}${snapshot.degradedReason ? ` reason=${snapshot.degradedReason}` : ""}${warn}`;
}
