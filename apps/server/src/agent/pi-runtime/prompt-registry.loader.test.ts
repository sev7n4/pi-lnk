import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
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
} from "./prompt-registry.loader";

const write = (dir: string, file: string, text: string) => {
  const target = join(dir, file);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, text, "utf8");
  return dir;
};

const ONE = (over = "") => `---\nid: a.one\nversion: 1.0.0\ntitle: 规则一\norder: 10\nowner: agent-platform\nupdated: 2026-10-02\n---\n第一条规则。\n${over}`;

/** MANIFEST 既是登记处（L8），也是 L3 判定"内容是否变了"的基线快照。 */
const MANIFEST_OF = (id: string, version: string, contentHash: string) =>
  `version: 0.1.0\nentries:\n  - id: ${id}\n    version: ${version}\n    order: 10\n    contentHash: ${contentHash}\n`;

/**
 * 一份「合法」的合成 Registry：id 齐备、body 逐字等于 fallback 常量、group/unlessGroup 与磁盘一致。
 * 第三元是 unlessGroup——必须建模，否则 no_gen_claim.nogen 与 write_guard 会被多算进
 * core+writeTools+genTools 组合，把 L6 预算门禁在「干净目录」这条用例上炸掉（假失败）。
 */
const VALID: Array<[string, [string | undefined, number], string | undefined?]> = [
  ["identity.opening", [undefined, 10]],
  ["no_gen_claim.nogen", [undefined, 20], "genTools"],
  ["no_gen_claim.gen", [undefined, 20], undefined],
  ["sidebar_vision.tail", [undefined, 30]],
  ["memory_scope.tail", [undefined, 35]],
  ["media_tool_policy", ["writeTools", 40]],
  ["canvas_view_policy", ["writeTools", 45]],
  // W4（2026-10-04）：画布日常操作（排版/查看/任务/资产 + tool_search 触发）
  ["canvas_daily_ops", ["writeTools", 46]],
  ["gen_tool_policy", ["genTools", 50]],
  ["write_guard", [undefined, 60], "writeTools"],
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

describe("assertRegistryIntegrity（L1-L9 负例各一条）", () => {
  const base = () => mkdtempSync(join(tmpdir(), "pr-"));
  const FULL = MANIFEST_OF("a.one", "1.0.0", contentHash("第一条规则。"));

  it("干净目录返回空数组", () => {
    const root = base();
    const manifest = ["version: 0.1.0", "", "entries:"];
    for (const [id, meta, unlessGroup] of VALID) {
      const body = FALLBACK_BY_ID[id];
      const fm = ["---", `id: ${id}`, "version: 1.0.0", `title: ${id}`, `order: ${meta[1]}`,
        "owner: agent-platform", "updated: 2026-10-02", ...(meta[0] ? [`group: ${meta[0]}`] : []),
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
