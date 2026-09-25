import { describe, expect, it } from "vitest";
import { parseSkillCommand } from "./skill-command.js";

describe("parseSkillCommand（可观测性专项 ④）", () => {
  it("命中 /skill <name> <rest>", () => {
    expect(parseSkillCommand("/skill ecommerce-product-photo 帮我做白底图")).toEqual({
      name: "ecommerce-product-photo",
      rest: "帮我做白底图",
    });
  });

  it("A5b: rest 为空时回退默认请求语", () => {
    expect(parseSkillCommand("/skill ecommerce-product-photo")).toEqual({
      name: "ecommerce-product-photo",
      rest: "",
    });
  });

  it("非 /skill 开头返回 null", () => {
    expect(parseSkillCommand("帮我做一张白底图")).toBeNull();
    expect(parseSkillCommand("/skills")).toBeNull();
    expect(parseSkillCommand("/skill   ")).toBeNull();
  });
});
