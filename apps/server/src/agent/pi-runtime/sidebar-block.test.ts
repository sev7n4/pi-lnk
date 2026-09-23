import { describe, expect, it } from "vitest";
import { assignSidebarRefKeys, buildSidebarBlock } from "./sidebar-block";

describe("侧栏 key 分配与素材块（sidebar_attachments.py 平移）", () => {
	it("key 按 mediaType 分类计数，未知类型跳过", () => {
		expect(
			assignSidebarRefKeys([
				{ mediaType: "image" },
				{ mediaType: "text" },
				{ mediaType: "image" },
				{ mediaType: "" },
			]),
		).toEqual(["I1", "T1", "I2"]);
	});

	it("buildSidebarBlock：无素材返回空串", () => {
		expect(buildSidebarBlock([])).toBe("");
	});

	it("有素材逐行列出：url 取末段去 query，text 优先", () => {
		const block = buildSidebarBlock([
			{ url: "https://cdn.x/a/b.png?sign=1", mediaType: "image" },
			{ text: "产品文案草稿", mediaType: "text" },
		]);
		expect(block).toBe("侧栏参考素材：\nI1=b.png\nT1=产品文案草稿");
	});

	it("url 无法取末段时整串兜底；text 优先于 url", () => {
		expect(buildSidebarBlock([{ url: "https://x/a", mediaType: "image" }])).toBe(
			"侧栏参考素材：\nI1=a",
		);
		expect(
			buildSidebarBlock([{ url: "https://x/a.png", text: "主图", mediaType: "image" }]),
		).toBe("侧栏参考素材：\nI1=主图");
	});
});
