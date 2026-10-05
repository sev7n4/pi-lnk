import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ANCHOR_CHARSET,
  ANCHOR_CHARSET_IN_TEXT,
  assertRegistryIntegrity,
  checkRegistryIntegrity,
  COMPOSED_IDS,
  contentHash,
  FALLBACK_BY_ID,
  loadRegistry,
  normalizeManifest,
  parseFrontmatter,
  parseManifest,
  registryHashOf,
  renderStatic,
  renderStaticFallback,
  resolveRegistryRoot,
  STATIC_BUDGET_CHARS,
  STATIC_BUDGET_WARN_CHARS,
  summarize,
  toRuleMeta,
} from "./prompt-registry.loader";

const write = (dir: string, file: string, text: string) => {
  const target = join(dir, file);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, text, "utf8");
  return dir;
};

const ONE = (over = "") => `---\nid: a.one\nversion: 1.0.0\ntitle: 规则一\norder: 10\nowner: agent-platform\nupdated: 2026-10-02\nanchor: solo-anchor\n---\n第一条规则。\n${over}`;

/** MANIFEST 既是登记处（L8），也是 L3 判定"内容是否变了"的基线快照。 */
const MANIFEST_OF = (id: string, version: string, contentHash: string) =>
  `version: 0.1.0\nentries:\n  - id: ${id}\n    version: ${version}\n    order: 10\n    contentHash: ${contentHash}\n`;

/**
 * 造一个临时 registry 根，把给定 frontmatter 字段 + body 落成 `rules/<file>.md`。
 * 只服务 L11 负例：故意不给全量必填字段，断言只看自己关心的那条错误码，
 * 不牵连 L1/L8/L9（那些各有自己的负例用例）。
 */
const rootOf = (files: Array<{ file: string; body: string; fields: Record<string, string> }>) => {
  const root = mkdtempSync(join(tmpdir(), "pr-anchor-"));
  for (const f of files) {
    const fm = ["---", ...Object.entries(f.fields).map(([k, v]) => `${k}: ${v}`), "---"];
    write(root, `rules/${f.file}.md`, `${fm.join("\n")}\n${f.body}`);
  }
  return root;
};

/**
 * 一份「合法」的合成 Registry：id 齐备、body 逐字等于 fallback 常量、group/unlessGroup 与磁盘一致。
 * 第三元是 unlessGroup——必须建模，否则 no_gen_claim.nogen 与 write_guard 会被多算进
 * core+writeTools+genTools 组合，把 L6 预算门禁在「干净目录」这条用例上炸掉（假失败）。
 * 第四元是 anchor：L11 起为必填且要求全局唯一，10 条各给一个语义短名（与磁盘 frontmatter 一致）。
 */
const VALID: Array<[string, [string | undefined, number], string | undefined, string]> = [
  ["identity.opening", [undefined, 10], undefined, "identity-and-truthfulness"],
  ["no_gen_claim.nogen", [undefined, 20], "genTools", "no-gen-tools"],
  ["no_gen_claim.gen", [undefined, 20], undefined, "no-gen-claim"],
  ["sidebar_vision.tail", [undefined, 30], undefined, "no-template"],
  ["memory_scope.tail", [undefined, 35], undefined, "memory-scope-isolation"],
  ["media_tool_policy", ["writeTools", 40], undefined, "media-tool-policy"],
  ["canvas_view_policy", ["writeTools", 45], undefined, "canvas-view-card"],
  // W4（2026-10-04）：画布日常操作（排版/查看/任务/资产 + tool_search 触发）
  ["canvas_daily_ops", ["writeTools", 46], undefined, "canvas-daily-ops"],
  ["gen_tool_policy", ["genTools", 50], undefined, "gen-gate"],
  ["write_guard", [undefined, 60], "writeTools", "readonly-session-guard"],
];

describe("parseFrontmatter", () => {
  it("无 frontmatter 时把全文当 body", () => {
    const { fields, body } = parseFrontmatter("纯文本\n第二行");
    expect(fields).toEqual({});
    expect(body).toBe("纯文本\n第二行");
  });

  it("按 vendor 约定：首行 --- 起、终止于 \\n---，从索引 3 起找", () => {
    const { fields, body } = parseFrontmatter(ONE());
    expect(fields).toMatchObject({ id: "a.one", version: "1.0.0", order: "10" });
    expect(fields.group).toBeUndefined();
    expect(body).toBe("第一条规则。");
  });

  it("缺少终止分隔符时报错", () => {
    expect(() => parseFrontmatter("---\nid: a.one\nbody")).toThrow(/终止/);
  });

  it("frontmatter 含中文冒号与英文 # 时不切错字段", () => {
    const { fields } = parseFrontmatter(`---\nid: a.two\nversion: 1.0.0\n# 注释：中文冒号：在这里\ntitle: 含冒号\norder: 20\nowner: agent-platform\nupdated: 2026-10-02\n---\n正文`);
    expect(fields.id).toBe("a.two");
    expect(fields.title).toBe("含冒号");
  });

  it("带双引号的值会脱引号", () => {
    const { fields } = parseFrontmatter(`---\nid: a.three\nversion: "1.0.0"\ntitle: 引\norder: 30\nowner: agent-platform\nupdated: 2026-10-02\n---\n正文`);
    expect(fields.version).toBe("1.0.0");
  });
});

describe("contentHash / registryHashOf", () => {
  it("同输入同输出（12 位 hex）", () => {
    expect(contentHash("第一条规则。")).toMatch(/^[0-9a-f]{12}$/);
    expect(contentHash("第一条规则。")).toBe(contentHash("第一条规则。"));
  });

  it("normalizeManifest 对乱序输入结果稳定（确定性排序硬要求）", () => {
    const a = [{ id: "b", version: "1.0.0", order: 2, contentHash: "h2" }, { id: "a", version: "2.0.0", order: 1, contentHash: "h1" }];
    const b = [...a].reverse();
    expect(normalizeManifest(a as never)).toBe(normalizeManifest(b as never));
    expect(registryHashOf(a as never)).toBe(registryHashOf(b as never));
  });
});

describe("parseManifest", () => {
  it("按 - id: 分块读多条，同块内 version/order/contentHash 不互相覆盖", () => {
    const text = "version: 0.1.0\nentries:\n  - id: a.one\n    version: 1.0.0\n    order: 10\n    contentHash: h1\n  - id: a.two\n    version: 2.0.0\n    order: 20\n    contentHash: h2\n";
    expect(parseManifest(text)).toEqual([
      { id: "a.one", version: "1.0.0", order: 0, contentHash: "h1" },
      { id: "a.two", version: "2.0.0", order: 0, contentHash: "h2" },
    ]);
  });

  it("空 entries 返回空数组", () => {
    expect(parseManifest("version: 0.1.0\nentries: []\n")).toEqual([]);
  });
});

describe("resolveRegistryRoot", () => {
  it("显式环境变量优先", () => {
    process.env.PI_PROMPT_REGISTRY_DIR = "/tmp/whatever";
    expect(resolveRegistryRoot()).toBe("/tmp/whatever");
    delete process.env.PI_PROMPT_REGISTRY_DIR;
  });

  it("从 cwd 向上找到仓库根的 prompt-registry", () => {
    expect(existsSync(join(resolveRegistryRoot(), "rules"))).toBe(true);
  });
});

describe("loadRegistry", () => {
  it("正常读盘：条目数、body 去尾空行、hash、degraded=false", () => {
    const root = write(mkdtempSync(join(tmpdir(), "pr-")), "rules/a.one.md", ONE());
    const snap = loadRegistry(root);
    expect(snap.degraded).toBe(false);
    expect(snap.entries).toHaveLength(1);
    expect(snap.entries[0].body).toBe("第一条规则。");
    expect(snap.entries[0].contentHash).toMatch(/^[0-9a-f]{12}$/);
    expect(snap.registryVersion).toBe("");
  });

  it("目录读不到时 fail-soft：degraded=true 且给出原因，不抛", () => {
    const snap = loadRegistry("/tmp/definitely-not-here");
    expect(snap.degraded).toBe(true);
    expect(snap.degradedReason).toBeTruthy();
    expect(snap.entries).toEqual([]);
  });
});

describe("renderStatic", () => {
  const entry = (id: string, order: number, body: string, group?: string, unlessGroup?: string) =>
    ({ id, version: "1.0.0", title: "t", order, owner: "o", updated: "2026-10-02", body, contentHash: "h", group, unlessGroup });
  const snap = { registryVersion: "0.1.0", registryHash: "h", entries: [
    entry("identity", 10, "PREFIX"), entry("nogen", 20, "RULE3", undefined, "genTools"), entry("gen", 20, "RULE3'", "genTools"),
    entry("tail", 30, "TAIL"), entry("media", 40, "WRITE", "writeTools"), entry("gen2", 50, "GEN", "genTools"),
    entry("guard", 60, "GUARD", undefined, "writeTools"),
  ], degraded: false };

  it("groups 空时返回空串", () => {
    expect(renderStatic(snap, [])).toBe("");
  });

  it("core 组 → 恒注入条目按 order 升序拼", () => {
    expect(renderStatic(snap, ["core"])).toBe("PREFIX\nRULE3\nTAIL\nGUARD");
  });

  it("core+writeTools → 追加 writeTools 组，unlessGroup 条目退出", () => {
    expect(renderStatic(snap, ["core", "writeTools"])).toBe("PREFIX\nRULE3\nTAIL\nWRITE");
  });

  it("core+genTools → 同一 order 的互斥版本取 group 命中那条，再追加 genTools 组", () => {
    expect(renderStatic(snap, ["core", "genTools"])).toBe("PREFIX\nRULE3'\nTAIL\nGEN\nGUARD");
  });

  it("三组全开 → writeTools 先于 genTools", () => {
    expect(renderStatic(snap, ["core", "writeTools", "genTools"])).toBe("PREFIX\nRULE3'\nTAIL\nWRITE\nGEN");
  });
});

describe("renderStaticFallback", () => {
  it("绕过 snapshot 直接出内嵌常量文本", () => {
    expect(renderStaticFallback(["core"])).toContain("你是 lnkpi 无限画布助手");
  });

  /**
   * 退路不漏规则：磁盘渲染与内嵌常量必须逐字符相等。
   *
   * 这是 2026-10-03 加 canvas_view_policy 时真实踩过的坑——renderStaticFallback()
   * 的parts.push 漏了新规则，容器读不到 registry 时该规则整段消失且**无任何报错**
   * （degraded 本身就是静默降级）。四组合全等是唯一能提前抓住它的判据：
   * 漏一条的长度差恰好等于该规则的 body 字符数。
   */
  it("四组合逐字符等于磁盘渲染（漏拼任何一条都会红）", () => {
    const snap = loadRegistry(resolveRegistryRoot());
    expect(snap.degraded).toBe(false);
    for (const groups of [["core"], ["core", "writeTools"], ["core", "genTools"], ["core", "writeTools", "genTools"]] as const) {
      const fromDisk = renderStatic(snap, groups);
      const fromConstants = renderStaticFallback(groups);
      // 差异信息要能直接指出漏了谁，否则只看到长度差无法定位
      if (fromDisk !== fromConstants) {
        const missing = snap.entries
          .filter((e) => fromDisk.includes(e.body.slice(0, 12)) && !fromConstants.includes(e.body.slice(0, 12)))
          .map((e) => e.id);
        throw new Error(
          `组合 ${groups.join("+")} 两路不等：磁盘 ${fromDisk.length} vs 常量 ${fromConstants.length}；` +
          `仅磁盘有：${missing.join(", ") || "（无，整段内容不同而非缺条）"}`
        );
      }
    }
  });
});

describe("assertRegistryIntegrity（L0-L11 负例各一条）", () => {
  const base = () => mkdtempSync(join(tmpdir(), "pr-"));
  const FULL = MANIFEST_OF("a.one", "1.0.0", contentHash("第一条规则。"));

  it("干净目录返回空数组", () => {
    const root = base();
    const manifest = ["version: 0.1.0", "", "entries:"];
    for (const [id, meta, unlessGroup, anchor] of VALID) {
      const body = FALLBACK_BY_ID[id];
      const fm = ["---", `id: ${id}`, "version: 1.0.0", `title: ${id}`, `order: ${meta[1]}`,
        "owner: agent-platform", "updated: 2026-10-02", `anchor: ${anchor}`,
        ...(meta[0] ? [`group: ${meta[0]}`] : []),
        ...(unlessGroup ? [`unlessGroup: ${unlessGroup}`] : []), "---"];
      write(root, `rules/${id}.md`, `${fm.join("\n")}\n${body}\n`);
      manifest.push(`  - id: ${id}`, "    version: 1.0.0", `    order: ${meta[1]}`, `    contentHash: ${contentHash(body)}`);
    }
    write(root, "MANIFEST.yaml", `${manifest.join("\n")}\n`);
    expect(assertRegistryIntegrity(root)).toEqual([]);
  });

  it("L1 frontmatter 缺字段", () => {
    const root = base();
    write(root, "MANIFEST.yaml", FULL);
    write(root, "rules/a.one.md", "---\nid: a.one\n---\n第一条规则。\n");
    expect(assertRegistryIntegrity(root).join("\n")).toMatch(/L1/);
  });

  it("L2 id 与文件名不一致", () => {
    const root = base();
    write(root, "MANIFEST.yaml", FULL);
    write(root, "rules/a.one.md", ONE().replace("id: a.one", "id: a.other"));
    expect(assertRegistryIntegrity(root).join("\n")).toMatch(/L2/);
  });

  it("L3 body 改了但 MANIFEST 里的 contentHash 与 version 没同步（强制 bump 义务）", () => {
    const root = base();
    write(root, "MANIFEST.yaml", MANIFEST_OF("a.one", "1.0.0", "000000000000"));
    write(root, "rules/a.one.md", ONE().replace("第一条规则。", "改了内容"));
    expect(assertRegistryIntegrity(root).join("\n")).toMatch(/L3/);
  });

  it("L4 group 取值不在白名单", () => {
    const root = base();
    write(root, "MANIFEST.yaml", FULL);
    write(root, "rules/a.one.md", ONE().replace("order: 10", "order: 10\ngroup: whatever"));
    expect(assertRegistryIntegrity(root).join("\n")).toMatch(/L4/);
  });

  it("L5 body 含尾随空行", () => {
    const root = base();
    write(root, "MANIFEST.yaml", FULL);
    write(root, "rules/a.one.md", `${ONE()}\n\n`);
    expect(assertRegistryIntegrity(root).join("\n")).toMatch(/L5/);
  });

  it("L5 body 含裸尖括号（会进 CDATA 吞掉文档）", () => {
    const root = base();
    write(root, "MANIFEST.yaml", FULL);
    write(root, "rules/a.one.md", ONE().replace("第一条规则。", "<style>别这样</style>"));
    expect(assertRegistryIntegrity(root).join("\n")).toMatch(/L5/);
  });

  it("L7 fallback 常量与文件不一致", () => {
    const root = base();
    write(root, "MANIFEST.yaml", FULL);
    write(root, "rules/identity.opening.md", ONE().replace("id: a.one", "id: identity.opening").replace("第一条规则。", "别的文案"));
    const errs = assertRegistryIntegrity(root).join("\n");
    expect(errs).toMatch(/L7/);
  });

  it("L8 MANIFEST 漏登记", () => {
    const root = base();
    write(root, "MANIFEST.yaml", "version: 0.1.0\nentries: []\n");
    write(root, "rules/a.one.md", ONE());
    expect(assertRegistryIntegrity(root).join("\n")).toMatch(/L8/);
  });
});

/**
 * L6 预算判据必须真正消费常量与BUDGET_COMBOS。
 *
 * 2026-10-03 踩过：STATIC_BUDGET_CHARS 从 2400 上调到 3200，但 L6 判据处仍写死2400
 * ⇒ 三个新常量零消费点、lint 照红报 2 条 L6。这类"加了常量没接线"不会被
 * tsc 抓到（常量被导出就算合法），只有断言判据用常量才拦得住。
 */
describe("L6 预算（判据必须用常量，不能写死数字）", () => {
  it("四组合全在硬线内 ⇒ errors 空", () => {
    const { errors } = checkRegistryIntegrity(resolveRegistryRoot());
    expect(errors.filter((e) => e.includes("L6"))).toEqual([]);
  });

  it("当前仓库已过预警线 ⇒ 登记 warnings 但不阻断（余量可见）", () => {
    const { errors, warnings } = checkRegistryIntegrity(resolveRegistryRoot());
    const full = renderStatic(loadRegistry(resolveRegistryRoot()), ["core", "writeTools", "genTools"]).length;
    expect(full).toBeLessThanOrEqual(STATIC_BUDGET_CHARS);
    if (full >= STATIC_BUDGET_WARN_CHARS) {
      // 已过预警线是当前预期状态（2880 ≥ 2720）：必须登记、且不得进 errors
      expect(warnings.some((w) => w.includes("预警线"))).toBe(true);
      expect(errors.some((e) => e.includes("预警"))).toBe(false);
    }
  });

  it("超硬线 ⇒ 进 errors（不是 warnings）", () => {
    // 用一条超长规则把 core 组合顶过硬线。此目录故意不满足 L9（缺其余 id），
    // 断言只看 L6 那条存在，不牵连其他错误码。
    const root = mkdtempSync(join(tmpdir(), "pr-budget-"));
    const filler = "长".repeat(STATIC_BUDGET_CHARS + 100);
    write(root, "MANIFEST.yaml", MANIFEST_OF("a.big", "1.0.0", contentHash(filler)));
    write(root, "rules/a.big.md", `---\nid: a.big\nversion: 1.0.0\ntitle: a.big\norder: 10\nowner: x\nupdated: 2026-10-03\n---\n${filler}\n`);
    const { errors, warnings } = checkRegistryIntegrity(root);
    expect(errors.some((e) => e.includes("L6") && e.includes(String(STATIC_BUDGET_CHARS)))).toBe(true);
    // 超硬线是错误不是预警：warnings 里不该出现"超过"
    expect(warnings.some((w) => w.includes("超过"))).toBe(false);
  });
});

/**
 * L11：anchor 必填 + 全局唯一 + **字符集合规**。
 *
 * anchor 是「本规则自己的稳定语义短名」，也是 L10 语义引用（`见 <短名>`）的**目标标识**——
 * 不是它引用的东西。缺了 ⇒ 引用扫不到目标、无人报错；重了 ⇒ 引用指向哪条产生歧义。
 *
 *⚠️ 字符集这条不是洁癖，是**堵一条假绿通道**：L10 的扫描正则只认「小写字母+连字符」，
 * 而 L11 若只判空+唯一，则 anchor 写成 `Gen_Confirm` / `gen_confirm` / `gen.confirm` /中文时，
 * 正文里 `见 \`Gen_Confirm\`` **扫不到** ⇒ L10 静默绿、断链无告警——恰是本任务要消灭的那类失效。
 * 收紧 L11 让不合规 anchor 在**写入时**就被拦下，两个判据的契约才闭合。
 * ⚠️ 反方向（放宽 L10 去匹配任意字符）是错的：那会让 L10 去扫工具名（`upsert_media_node`）重新误报。
 */
describe("L11 anchor（语义短名必填、全局唯一且字符集合规）", () => {
  it("L11：规则缺 anchor 字段时报错（L10 语义引用靠它定位，缺了就扫不到）", () => {
    const { errors } = checkRegistryIntegrity(
      rootOf([{ file: "a.one", body: "正文。\n", fields: { title: "A" } }]),
    );
    expect(errors.some((e) => e.startsWith("L11"))).toBe(true);
  });

  it("L11：anchor 重复时报错（两个规则抢同一语义短名会让引用歧义）", () => {
    const { errors } = checkRegistryIntegrity(
      rootOf([
        // ⚠️ 重复值必须用 ≥4 字符的合法 anchor：否则新的字符集校验会先报「不合规」，
        // 让这条用例绿的原因从「重复」漂移到「字符集」，断言 e.includes("重复") 就会红。
        { file: "a.one", body: "正文一。\n", fields: { title: "A", anchor: "dup-anchor" } },
        { file: "a.two", body: "正文二。\n", fields: { title: "B", anchor: "dup-anchor" } },
      ]),
    );
    expect(errors.some((e) => e.includes("anchor") && e.includes("重复"))).toBe(true);
  });

  // ↓ 假绿通道：以下每种 anchor 都能让正文里的「见 `X`」被 L10 扫漏。
  //   断言必须真的红在「加了字符集校验之前」——为此每条都要求L11 报出**字符集**那条error。
  for (const bad of ["Gen_Confirm", "gen_confirm", "gen.confirm", "genConfirm", "生成确认门", "ab", "9anchor"]) {
    it(`L11：anchor「${bad}」不合规时报错（否则 L10 扫不到引用、断链无告警）`, () => {
      const { errors } = checkRegistryIntegrity(
        rootOf([{ file: "a.one", body: "正文。\n", fields: { title: "A", anchor: bad } }]),
      );
      expect(errors.some((e) => e.startsWith("L11") && e.includes(bad))).toBe(true);
    });
  }

  it("L11：合法 anchor 不被字符集校验误伤（正例：真实 anchor 同形态）", () => {
    for (const good of ["no-template", "no-gen-tools", "gen-gate", "real-anchor", "dup-anchor"]) {
      const { errors } = checkRegistryIntegrity(
        rootOf([{ file: "a.one", body: "正文。\n", fields: { title: "A", anchor: good } }]),
      );
      expect(errors.filter((e) => e.startsWith("L11"))).toEqual([]);
    }
  });

  it("L11 字符集与 L10 扫描字符集同源（断言生产两侧派生一致，不另写副本）", () => {
    // ⚠️ 这条**不再**在测试里另写一份 L10_CHARSET 副本。
    // 旧写法（const L10_CHARSET = /^[a-z][a-z0-9-]{3,}$/）的注释承诺「若有人日后放宽了 L10 的
    // 字符集，这条会提醒同步」——该承诺不成立，已RED 取证证伪（见报告）：
    //   · 放宽「允许大写开头」→ 6 个 bad 锚点判定全不变 ⇒ 用例**仍绿**（连假红都不产生）；
    //   · 放宽「允许下划线/点号/缩短长度/完全放开」⇒ 用例转红，但红因是**测试副本陈旧**，
    //     不是生产侧 L10/L11 契约真的断裂 ⇒ 假红信号。
    // 根因：它只喂非法 anchor 给 L11，而 L11 用的本来就是生产 ANCHOR_CHARSET，
    // 于是这条用例守的是「非法 anchor 被 L11 拦」，与它声称的「L10/L11 同源」不是同一件事。
    //
    // ✅ 真实防线是**生产侧结构**（loader.ts:67）：
    //     ANCHOR_CHARSET_IN_TEXT = ANCHOR_CHARSET.source剥掉 ^ $
    // 下面直接断言这个派生关系成立—— 生产两侧真的共用同一份字符集定义。
    expect(ANCHOR_CHARSET_IN_TEXT).toBe(ANCHOR_CHARSET.source.replace(/^\^/, "").replace(/\$$/, ""));
    // 剥锚点后必须仍是非空字符集本体（不是整条带 ^$ 的串，否则嵌进句中正则永不匹配）
    expect(ANCHOR_CHARSET_IN_TEXT).not.toMatch(/[\^$]/);
    expect(ANCHOR_CHARSET_IN_TEXT.length).toBeGreaterThan(0);

    // 派生出的句中字符集放进 L10 的真实扫描模式，验证「合规 anchor 扫得到」这一端
    const l10 = new RegExp(String.raw`见\s*` + "`" + String.raw`?(${ANCHOR_CHARSET_IN_TEXT})(?![A-Za-z0-9_-])`);
    for (const good of ["media-tool-policy", "gen-gate", "solo-anchor"]) {
      expect({ good, hit: l10.test(`见 \`${good}\``) }).toEqual({ good, hit: true });
      // 反引号可选（loader.ts:381）：裸写也要能扫到，否则 L10 对真实文案静默空转
      expect({ good, hit: l10.test(`见 ${good}`) }).toEqual({ good, hit: true });
    }
    // ⚠️ 中文引号扫不到 ⇒ 断链 L10 静默绿。这正是 PROMPT_SPEC §6.1 要求「必须用反引号」的原因。
    for (const quoted of ["见「media-tool-policy」", "见 “media-tool-policy”"]) {
      expect(l10.test(quoted)).toBe(false);
    }
    // 零误报（spec §7.3）：下划线工具名不得被截成 anchor 引用
    expect(l10.test("见 upsert_media_node")).toBe(false);

    // L11 侧：不合规 anchor 必须被拦（这一半仍由生产 ANCHOR_CHARSET 决定）
    for (const bad of ["Gen_Confirm", "gen_confirm", "gen.confirm", "生成确认门", "ab", "9anchor"]) {
      const { errors } = checkRegistryIntegrity(
        rootOf([{ file: "a.one", body: "正文。\n", fields: { title: "A", anchor: bad } }]),
      );
      expect(errors.some((e) => e.startsWith("L11") && e.includes(bad))).toBe(true);
      // 合规 ⇔ 句中形态扫得到：同一份字符集 ⇒ 不存在「anchor 合规但 L10 扫不到」的组合
      expect({ bad, l10WouldMatch: l10.test(`见 ${bad}`) }).toEqual({ bad, l10WouldMatch: false });
    }
  });

  it("回归：磁盘上 10 条规则的 anchor 全在、互不相同且字符集合规（L11 对真实资产零 error）", () => {
    const { errors } = checkRegistryIntegrity(resolveRegistryRoot());
    expect(errors.filter((e) => e.includes("L11"))).toEqual([]);
    // 正面断言：10 条 anchor 逐条过字符集（防上面那条回归用例变成空断言）
    const metas = toRuleMeta(loadRegistry(resolveRegistryRoot()).entries);
    expect(metas).toHaveLength(10);
    for (const m of metas) expect(m.anchor).toMatch(/^[a-z][a-z0-9-]{3,}$/);
  });
});

/**
 * L10：body 里的「见 `<anchor>`」引用必须指向真实存在的 anchor。
 *
 * 引用形如「见 `gen-gate`」——语义在短名里，不在编号里；编号重排即静默断链。
 * 正则只认「反引号可选 + 小写字母数字连字符 + 至少 4 字符 + 右边界」，
 * 于是「见规则 14」「禁止见 upsert_media_node」都不会被当成 anchor 引用（spec §7.3「零误报」）。
 */
describe("L10 语义引用有效性", () => {
  it("L10：规则引用了不存在的 anchor 时报错", () => {
    const { errors } = checkRegistryIntegrity(
      rootOf([{ file: "a.one", body: "见 `no-template` 说的那样。\n", fields: { title: "A", anchor: "real-anchor" } }]),
    );
    expect(errors.some((e) => e.startsWith("L10") && e.includes("no-template"))).toBe(true);
  });

  it("L10：引用真实存在的 anchor 时不报错", () => {
    const { errors } = checkRegistryIntegrity(
      rootOf([
        { file: "a.one", body: "见 `real-anchor` 说的那样。\n", fields: { title: "A", anchor: "real-anchor" } },
        { file: "a.two", body: "正文。\n", fields: { title: "B", anchor: "other-anchor" } },
      ]),
    );
    expect(errors.filter((e) => e.startsWith("L10"))).toEqual([]);
  });

  it("L10：旧数字引用「见规则 14」不算 anchor 引用（避免中文误判）", () => {
    // 正则要求 anchor 为小写字母+连字符 ⇒「规则 14」不匹配，L10 不应命中
    const { errors } = checkRegistryIntegrity(
      rootOf([{ file: "a.one", body: "见规则 14 就这样。\n", fields: { title: "A", anchor: "x-anchor" } }]),
    );
    expect(errors.filter((e) => e.startsWith("L10"))).toEqual([]);
  });

  it("L10：带反引号的引用（真实资产写法）能匹配到", () => {
    // ⚠️ 锁住反引号：磁盘上两处真实引用都写成「见 `anchor`」，若正则漏了可选反引号，
    // 这两条会静默扫不到 ⇒ L10 变成永远绿的空判据。
    const { errors } = checkRegistryIntegrity(
      rootOf([{ file: "a.one", body: "见 `ghost-anchor` 说的那样。\n", fields: { title: "A", anchor: "real-anchor" } }]),
    );
    expect(errors.some((e) => e.startsWith("L10") && e.includes("ghost-anchor"))).toBe(true);
  });

  it("L10：下划线标识符（upsert_media_node）不被截断成 anchor 引用（spec §7.3 零误报）", () => {
    // 「禁止见 upsert_media_node」若按 [a-z][a-z0-9-]{3,} 匹配会截出 'upsert' ⇒ 误报 L10。
    const { errors } = checkRegistryIntegrity(
      rootOf([{ file: "a.one", body: "禁止见 upsert_media_node 这样用。\n", fields: { title: "A", anchor: "x-anchor" } }]),
    );
    expect(errors.filter((e) => e.startsWith("L10"))).toEqual([]);
  });

  it("回归：磁盘上两处真实 anchor 引用都能通过 L10（对真实资产零 error）", () => {
    const { errors } = checkRegistryIntegrity(resolveRegistryRoot());
    expect(errors.filter((e) => e.startsWith("L10"))).toEqual([]);
  });

  it("回归：磁盘上两处引用确实写成了 anchor 形态（否则上一条是空断言）", () => {
    // 防「L10 绿是因为正则谁都不匹配」的假绿：正面断言两条真实引用存在。
    const body = (id: string) =>
      parseFrontmatter(readFileSync(join(resolveRegistryRoot(), "rules", `${id}.md`), "utf8")).body;
    expect(body("media_tool_policy")).toContain("见 `no-template`");
    expect(body("no_gen_claim.gen")).toContain("见 `gen-gate`");
    // 且旧的数字引用已从这两条里清零
    expect(body("media_tool_policy")).not.toMatch(/规则\s*14/);
    expect(body("no_gen_claim.gen")).not.toMatch(/规则\s*11/);
  });
});

/**
 * `summarize` / `toRuleMeta`：规则地图生成器的数据通路（Task 4 契约测试复用）。
 *
 * 断言重点是**首句摘要不能留下悬空括号残句**——它读起来像规则本身写错了，
 * 而实际只是摘要被截断。硬切slice(0,60) 就会产出「用 upsert_media_node创建或更新节点（「这种。
 */
describe("summarize / toRuleMeta（规则地图生成器的数据通路）", () => {
  it("未超长时原样返回首句", () => {
    expect(summarize("你是助手。后面还有第二句。")).toBe("你是助手");
  });

  it("硬切会留悬空括号；收尾到语义边界并补… 后不残留未闭合括号", () => {
    // fixture 取media_tool_policy 首句的真实形态：硬切恰好落在左括号「（」上。
    const long = "4. 用户要创建图片/视频/文本/音频节点或明确「生成一张…」时：用 upsert_media_node创建或更新节点（带参）。后续还有更多内容在这里。";
    const hardCut = long.split("。")[0]!.slice(0, 60);
    expect(hardCut.endsWith("（")).toBe(true); // 旧硬切确实悬空
    const out = summarize(long);
    expect(out.endsWith("…")).toBe(true);
    expect(out.split("（").length).toBeLessThanOrEqual(out.split("）").length);
  });

  it("摘要里不含竖线（会破 Markdown 表格），且长度有上界", () => {
    for (const e of toRuleMeta(loadRegistry(resolveRegistryRoot()).entries)) {
      expect(e.firstSentence).not.toContain("|");
      expect(e.firstSentence.length).toBeLessThanOrEqual(61);
    }
  });

  it("toRuleMeta：从 PromptRegistryEntry[] 转换出 anchor 与首句，并按 order 升序", () => {
    const snap = loadRegistry(resolveRegistryRoot());
    const meta = toRuleMeta(snap.entries);
    expect(meta).toHaveLength(snap.entries.length);
    expect(meta.map((m) => m.anchor).filter(Boolean)).toHaveLength(snap.entries.length);
    expect([...meta].sort((a, b) => a.order - b.order)).toEqual(meta);
    // anchor 必须真的是每条规则自己的短名（不是它引用的目标）
    expect(meta.find((m) => m.id === "no_gen_claim.nogen")?.anchor).toBe("no-gen-tools");
    expect(meta.find((m) => m.id === "gen_tool_policy")?.anchor).toBe("gen-gate");
  });

  it("anchor 缺失时降级为空串而不抛（anchor 在 PromptRegistryEntry 上是可选字段）", () => {
    const [m] = toRuleMeta([{
      id: "a.one", version: "1.0.0", title: "t", order: 1, owner: "o", updated: "2026-10-04",
      body: "正文。\n", contentHash: "h",
    }]);
    expect(m.anchor).toBe("");
    expect(m.firstSentence).toBe("正文");
  });
});

/**
 * 生成器的 `--write` 幂等性判据。
 *
 * 真实事故：replacer 正则把 END 前的 `\n?` 放进了捕获组，组内吃掉换行而 replacer 又补一个
 * ⇒ 每次 --write 都在 END 前多插一个空行；第 2 次执行时 no-op guard 命中并报「缺标记块」，
 * 而标记块明明存在。--write 是规格 §6.4 变更流程第⑤ 步的正式入口，必须可重复执行。
 */
describe("gen-prompt-spec-map --write 幂等", () => {
  const BEGIN = "<!-- BEGIN:rule-map -->";
  const END = "<!-- END:rule-map -->";
  const MAP = "| 10 | `a` | T | core | S |";
  /** 复刻生成器的替换逻辑：`\n?` 在捕获组**外**，replacer 统一补一个换行。 */
  const applyWrite = (spec: string) =>
    spec.replace(new RegExp(`(${BEGIN}\\n)[\\s\\S]*?\\n?(${END})`), (_a, b: string, e: string) => `${b}${MAP}\n${e}`);

  for (const [name, start] of [
    ["空标记块（首次 --write 前的状态）", `${BEGIN}\n${END}\n`],
    ["已被旧版污染（END 前多一个空行）", `${BEGIN}\n| x |\n\n${END}\n`],
    ["正常已生成", `${BEGIN}\n${MAP}\n${END}\n`],
    ["标记块后还有正文", `# T\n\n${BEGIN}\n${END}\n\n## 4 分组机制\n\n尾巴\n`],
  ] as const) {
    it(`连续两次 --write 结果相同：${name}`, () => {
      const once = applyWrite(start);
      expect(applyWrite(once)).toBe(once);
      // END 前恰好一个换行，没有多出来的空行
      expect(once.slice(0, once.indexOf(END)).endsWith("\n")).toBe(true);
      expect(once.slice(0, once.indexOf(END)).endsWith("\n\n")).toBe(false);
    });
  }

  it("标记块真的不存在时正则不匹配（调用方据此报「缺标记块」而不是谎报已最新）", () => {
    expect(new RegExp(`(${BEGIN}\\n)[\\s\\S]*?\\n?(${END})`).test("# 标题\n\n## 3 规则地图\n\n占位\n")).toBe(false);
  });
});

/**
 * §8.1 case 3：规则顺序由 `order` 字段决定（防止静默错序）。
 *
 * 正例用「数组位置与 order 相反」的输入：若实现改成按entries 数组原序拼接，输出会翻成
 * "SECOND\nFIRST" 而红——这正是 order 字段形同虚设的失效形态。
 * 反例对照：只把两条的 order 对调、其余不动，输出必须跟着翻转（证明排序真读了 order）。
 */
describe("§8.1 case3：order 决定组装顺序", () => {
  const entry = (id: string, order: number, body: string) => ({
    id, version: "1.0.0", title: id, order, owner: "agent-platform", updated: "2026-10-04",
    body, contentHash: contentHash(body),
  });
  const snapOf = (entries: Array<ReturnType<typeof entry>>) => ({
    registryVersion: "1.0.0", registryHash: registryHashOf(entries), degraded: false, entries,
  });

  it("case3：entries 数组顺序与 order 相反时，仍按 order 升序输出", () => {
    // 故意把 order=20 的放前面：数组序 ≠ order 序
    const snap = snapOf([entry("b", 20, "SECOND"), entry("a", 10, "FIRST")]);
    expect(renderStatic(snap, ["core"])).toBe("FIRST\nSECOND");
    // 前置守卫：输入确实与输出相反（否则上面是恒真断言）
    expect(snap.entries.map((e) => e.body)).toEqual(["SECOND", "FIRST"]);
  });

  it("case3 反例对照：只对调 order，输出必须跟着翻转（order 真被消费）", () => {
    const before = renderStatic(snapOf([entry("b", 20, "SECOND"), entry("a", 10, "FIRST")]), ["core"]);
    const after = renderStatic(snapOf([entry("b", 10, "SECOND"), entry("a", 20, "FIRST")]), ["core"]);
    expect(before).toBe("FIRST\nSECOND");
    expect(after).toBe("SECOND\nFIRST");
    expect(after).not.toBe(before);
  });

  it("case3：磁盘真实Registry 的输出顺序 == toRuleMeta 的 order 升序（同一张地图）", () => {
    const snap = loadRegistry(resolveRegistryRoot());
    expect(snap.degraded).toBe(false);
    const metas = toRuleMeta(snap.entries);
    const rendered = renderStatic(snap, ["core", "writeTools", "genTools"]);
    // 用整条 body 定位（不能用首句前缀——多条规则首句前10字会撞车，撞车会让
    // indexOf 返回同一个位置，positions 变成非严格递增却仍"看起来有序"）。
    const bodyOf = new Map<string, string>(snap.entries.map((e): [string, string] => [e.id, e.body]));
    const positions = metas.map((m) => rendered.indexOf(bodyOf.get(m.id)!));
    // 缺席的两条恰好是互斥版本：nogen 被 genTools 的 unlessGroup 排除、write_guard 被 writeTools 排除。
    // ⚠️ 必须显式断言缺席名单，否则「缺席」会被 indexOf=-1 混进排序断言里而看不出是谁缺席。
    const absent = metas.filter((m) => positions[metas.indexOf(m)] === -1).map((m) => m.id);
    expect(absent).toEqual(["no_gen_claim.nogen", "write_guard"]);
    const present = positions.filter((p) => p >= 0);
    expect(present).toHaveLength(metas.length - 2);
    // 在场者的出现次序 == order 升序
    expect(present).toEqual([...present].sort((a, b) => a - b));
    // ⚠️ **本条的有效性依赖磁盘 manifest 的文件序不是 order 升序**（实测 [46,45,50,10,40,35,20,20,30,60]）：
    // 正因为「文件序 ≠ order 序」，实现若改成按 entries 数组原序拼接，本条会红。
    // 若日后有人把 manifest 排成升序，本条退化为恒真——**恒定防线是上面「合成输入 order 交换 ⇒ 输出必须变」
    // 那条**（输入数组序与 order 序相反，与磁盘文件序无关），以及紧随其后的「反转 order 后重算」反例。
  });

  /**
   * case3 真正的反例对照：把磁盘条目的 order 全部反转后重算 positions。
   *
   * ⚠️ 为什么不能只写 `[...present].reverse()).not.toEqual([...present].sort())`：
   * 前一条断言已确认 `present` 严格升序，它的 `.reverse()` **必然**不等于 `.sort()` 的结果
   * ⇒ 那是同义反复的恒真断言，零判别力（本任务评审实测确认的唯一恒真项）。
   *
   * 本条改为**真正扰动输入**：给第 i 条赋order = (n-i)*10（与数组序完全相反的严格序），
   * 于是「按 order 排序」与「按数组原序拼接」两条路径给出**相反**的输出序列。
   * 判据`positions` 升序只有在实现真的读了 `order` 时才成立——把 sort 去掉即转红（RED 取证见 task-4-report.md）。
   */
  it("case3 反例对照：反转全部 order 后重算，输出必须跟着新 order 走（RED 取证过的判据）", () => {
    const snap = loadRegistry(resolveRegistryRoot());
    const n = snap.entries.length;
    // 第 i 条 ⇒ order = (n-i)*10：数组序递增 ⇒ order 序严格递减，两者完全相反
    const flipped = snap.entries.map((e, i) => ({ ...e, order: (n - i) * 10 }));
    const rendered = renderStatic({ ...snap, entries: flipped }, ["core", "writeTools", "genTools"]);
    const bodyOf = new Map<string, string>(flipped.map((e): [string, string] => [e.id, e.body]));
    const posOf = (list: typeof flipped) => list.map((e) => rendered.indexOf(bodyOf.get(e.id)!));

    // 正向：按新 order 升序遍历在场条目，其在输出里的位置必须升序
    const presentByNewOrder = [...flipped].sort((a, b) => a.order - b.order).filter((e) => rendered.includes(e.body));
    expect(presentByNewOrder.length).toBeGreaterThanOrEqual(2);
    const positions = posOf(presentByNewOrder);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));

    // 反向：按数组原序遍历，同一批条目的位置必须**非**升序（否则上一条是恒真的）
    // 这正是「order 真被消费、不是按数组原序」的直接证据：两条路径的输出序列互为逆序。
    const positionsByArrayOrder = posOf(flipped.filter((e) => rendered.includes(e.body)));
    expect(positionsByArrayOrder).not.toEqual([...positionsByArrayOrder].sort((a, b) => a - b));
    // 且两条路径确实给出了不同的顺序（否则扰动无效）
    expect(presentByNewOrder.map((e) => e.id)).not.toEqual(
      flipped.filter((e) => rendered.includes(e.body)).map((e) => e.id),
    );
  });
});

/**
 * §8.1 case 6：磁盘上每条「见 `<anchor>`」引用都能解析（L10 双保险）。
 *
 * ⚠️ 为什么不等同于已有的「L10 对真实资产零 error」那条：那条断言的是**门禁自己**不报错；
 * 若门禁的扫描正则某天写坏了（永不匹配），它照样绿。本case**不复用 checkRegistryIntegrity**，
 * 而是自己独立扫一遍正文、拿 anchor 集合独立核对——门禁与本判据共用同一份磁盘资产，
 * 但走两条独立代码路径，任一条路径失效另一条仍会红。
 *
 * 反例对照：先证明「扫描确实扫到了东西」（refs.length > 0）且「虚构anchor 确实解析不了」，
 * 否则「全部可解析」在 refs 为空时是恒真断言（这正是前三个任务踩过的假绿形态）。
 */
describe("§8.1 case6：磁盘 anchor 引用全部可解析", () => {
  // 与 L10 同源的引用形态：反引号可选 + 小写字母数字连字符 + ≥4 字符 + 右边界
  const ANCHOR_REF = /见\s*`?([a-z][a-z0-9-]{3,})(?![A-Za-z0-9_-])/g;

  it("case6：磁盘每条「见 <anchor>」都指向真实存在的 anchor", () => {
    const snap = loadRegistry(resolveRegistryRoot());
    const anchors = new Set(toRuleMeta(snap.entries).map((m) => m.anchor).filter(Boolean));
    const refs = snap.entries.flatMap((e) =>
      [...e.body.matchAll(ANCHOR_REF)].map((m) => ({ from: e.id, ref: m[1]! })),
    );
    // ⚠️ 防假绿守卫 1：确实扫到了引用（否则「全部可解析」是空断言）
    expect(refs.length).toBeGreaterThanOrEqual(2);
    // ⚠️ 防假绿守卫 2：不存在的 anchor 必须解析不了（否则上一步的解析能力是假的）
    expect(anchors.has("ghost-anchor")).toBe(false);
    // 真正的判据：零悬空引用，且能指出是谁引用了谁
    const dangling = refs.filter((r) => !anchors.has(r.ref)).map((r) => `${r.from} → ${r.ref}`);
    expect(dangling).toEqual([]);
  });

  it("case6：与门禁 L10 判据结论一致（双保险互不打架）", () => {
    const { errors } = checkRegistryIntegrity(resolveRegistryRoot());
    expect(errors.filter((e) => e.startsWith("L10"))).toEqual([]);
  });
});

