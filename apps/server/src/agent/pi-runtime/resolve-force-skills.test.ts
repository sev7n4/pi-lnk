import { describe, expect, it } from "vitest";
import { resolveForceSkills } from "./resolve-force-skills.js";

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
