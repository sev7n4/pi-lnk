import { describe, expect, it } from "vitest";
import { assignSidebarRefKeys, buildSidebarBlock, buildImageRecoveryHint } from "./sidebar-block";

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

	it("有素材逐行列出：url 取末段去 query，text 优先；媒体行附完整 url（2026-11-05 事故修复：模型需真实 url 走 view_canvas_media 恢复）", () => {
		const block = buildSidebarBlock([
			{ url: "https://cdn.x/a/b.png?sign=1", mediaType: "image" },
			{ text: "产品文案草稿", mediaType: "text" },
		]);
		expect(block).toBe("侧栏参考素材：\nI1=b.png url=https://cdn.x/a/b.png?sign=1\nT1=产品文案草稿");
	});

	it("url 无法取末段时整串兜底；text 优先于 url", () => {
		expect(buildSidebarBlock([{ url: "https://x/a", mediaType: "image" }])).toBe(
			"侧栏参考素材：\nI1=a url=https://x/a",
		);
		expect(
			buildSidebarBlock([{ url: "https://x/a.png", text: "主图", mediaType: "image" }]),
		).toBe("侧栏参考素材：\nI1=主图 url=https://x/a.png");
	});
});

describe('B-2 minors', () => {
  it('F2：未知 mediaType 被过滤后再分配 key（不再错位）', () => {
    const block = buildSidebarBlock([
      { url: 'https://x/a.png', mediaType: 'image' },
      { text: '未知类型素材', mediaType: 'weird' },
      { url: 'https://x/c.png', mediaType: 'image' },
    ])
    expect(block).toContain('I1=a.png')
    expect(block).toContain('I2=c.png')
    expect(block).not.toContain('未知类型素材')
  })

  it('F6：text 素材超 200 字截断', () => {
    const long = 'x'.repeat(300)
    const block = buildSidebarBlock([{ text: long, mediaType: 'text' }])
    expect(block).toContain('T1=' + 'x'.repeat(200))
    expect(block).not.toContain('x'.repeat(201))
  })
})

describe("buildImageRecoveryHint（VISP S-7/M-9：直注失败时的恢复提示）", () => {
	it("有图片附件 → 含 read_media 指引与 key；key 跨 mediaType 计数", () => {
		const hint = buildImageRecoveryHint([
			{ text: "文案", mediaType: "text" },
			{ url: "http://h:8888/api/uploads/u1/a.png", mediaType: "image" },
			{ url: "http://h:8888/api/uploads/u1/b.jpg", mediaType: "image" },
		]);
		expect(hint).toContain("read_media");
		expect(hint).toContain('ref:"I1"');
		expect(hint).toContain("I1, I2");
	});

	it("无图片附件 / undefined → 空串（不污染动态块）", () => {
		expect(buildImageRecoveryHint([{ text: "文案", mediaType: "text" }])).toBe("");
		expect(buildImageRecoveryHint(undefined)).toBe("");
	});
});
