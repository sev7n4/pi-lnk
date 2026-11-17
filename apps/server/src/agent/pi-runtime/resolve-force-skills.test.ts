import { describe, expect, it } from "vitest";
import { resolveForceSkills, resolveForceSkillsMulti } from "./resolve-force-skills.js";

describe("resolveForceSkills（P1 skillId 转接）", () => {
  const known = [{ name: "ecommerce-product-photo" }, { name: "listing-copy" }];

  it("T2-1: skillId 命中白名单 → forceSkills=[name]，promptText 保持原消息", () => {
    const out = resolveForceSkills("ecommerce-product-photo", "帮我做白底图", known);
    expect(out).toEqual({ forceSkills: ["ecommerce-product-photo"], promptText: "帮我做白底图" });
  });

  it("T2-2: 文本 /skill 命令优先，skillId 不叠加", () => {
    const out = resolveForceSkills("listing-copy", "/skill ecommerce-product-photo 白底图", known);
    expect(out).toEqual({ forceSkills: ["ecommerce-product-photo"], promptText: "白底图" });
  });

  it("T2-3: skillId 未知名 fail-soft → 无 forceSkills，原文发送", () => {
    const out = resolveForceSkills("no-such-skill", "帮我做白底图", known);
    expect(out).toEqual({ forceSkills: undefined, promptText: "帮我做白底图" });
  });

  it("T2-4: 无 skillId 无命令 → 原样", () => {
    expect(resolveForceSkills(undefined, "你好", known)).toEqual({ forceSkills: undefined, promptText: "你好" });
    expect(resolveForceSkills("listing-copy", "帮我做白底图", null)).toEqual({ forceSkills: undefined, promptText: "帮我做白底图" });
  });

  it("P0 回归: /skill rest 为空时回退默认请求语；未知名降级原文", () => {
    expect(resolveForceSkills(undefined, "/skill listing-copy", known)).toEqual({
      forceSkills: ["listing-copy"],
      promptText: "请使用 skill listing-copy 完成我的需求",
    });
    expect(resolveForceSkills(undefined, "/skill no-such 白底图", known)).toEqual({
      forceSkills: undefined,
      promptText: "/skill no-such 白底图",
    });
  });
});

describe("resolveForceSkillsMulti（P3 多胶囊 → forceSkills 数组）", () => {
  const known = [{ name: "ecommerce-product-photo" }, { name: "listing-copy" }, { name: "html-craft" }];

  it("M-1: 多胶囊全命中 → forceSkills 多元素数组，去重保序，原文发送", () => {
    const out = resolveForceSkillsMulti(
      ["ecommerce-product-photo", "listing-copy", "ecommerce-product-photo"],
      "帮我做白底图和文案",
      known,
    );
    expect(out.forceSkills).toEqual(["ecommerce-product-photo", "listing-copy"]);
    expect(out.promptText).toBe("帮我做白底图和文案");
    expect(out.dropped).toEqual([]);
  });

  it("M-2: /skill 命令命中 + 胶囊并存 → 命令名居首、胶囊并入去重；promptText 走命令 rest", () => {
    const out = resolveForceSkillsMulti(["html-craft"], "/skill listing-copy 白底图", known);
    expect(out.forceSkills).toEqual(["listing-copy", "html-craft"]);
    expect(out.promptText).toBe("白底图");
  });

  it("M-3: /skill 未知名 + 胶囊命中 → 胶囊不背命令的锅：forceSkills=胶囊，promptText 原文", () => {
    const out = resolveForceSkillsMulti(["html-craft"], "/skill no-such 白底图", known);
    expect(out.forceSkills).toEqual(["html-craft"]);
    expect(out.promptText).toBe("/skill no-such 白底图");
  });

  it("M-4: 胶囊含未知名 → fail-soft 过滤进 dropped，不阻断；全未知名 → forceSkills=undefined", () => {
    const out = resolveForceSkillsMulti(["no-such", "listing-copy", "ghost"], "帮我", known);
    expect(out.forceSkills).toEqual(["listing-copy"]);
    expect(out.dropped).toEqual(["no-such", "ghost"]);
    const allBad = resolveForceSkillsMulti(["no-such"], "帮我", known);
    expect(allBad.forceSkills).toBeUndefined();
    expect(allBad.promptText).toBe("帮我");
  });

  it("M-5: 空胶囊 / known 不可用 → 原样（旧单版行为回归）", () => {
    expect(resolveForceSkillsMulti([], "你好", known)).toEqual({ forceSkills: undefined, promptText: "你好", dropped: [] });
    expect(resolveForceSkillsMulti(["listing-copy"], "帮我", null)).toEqual({ forceSkills: undefined, promptText: "帮我", dropped: [] });
  });

  it("M-6: 旧单版与 Multi 单元素等价（委托关系回归）", () => {
    const legacy = resolveForceSkills("listing-copy", "帮我做白底图", known);
    const multi = resolveForceSkillsMulti(["listing-copy"], "帮我做白底图", known);
    expect({ forceSkills: multi.forceSkills, promptText: multi.promptText }).toEqual(legacy);
  });
});
