import { describe, expect, it } from "vitest";
import { assignSidebarRefKeys, buildSidebarBlock, buildImageRecoveryHint, buildImageInjectedNotice } from "./sidebar-block";

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

describe("buildImageInjectedNotice（VISP 2026-11-06 生产事故：直注成功时明示图已在上下文）", () => {
	it("有图片附件 → 明示像素已注入 + read_media 重读指引（键跨 mediaType 计数）", () => {
		const notice = buildImageInjectedNotice([
			{ text: "文案", mediaType: "text" },
			{ url: "http://h:8888/api/uploads/u1/a.png", mediaType: "image" },
			{ url: "http://h:8888/api/uploads/u1/b.jpg", mediaType: "image" },
		]);
		expect(notice).toContain("原图已注入");
		expect(notice).toContain("I1, I2");
		expect(notice).toContain('read_media(ref:"I1")');
	});

	it("无图片附件 / undefined → 空串", () => {
		expect(buildImageInjectedNotice([{ text: "文案", mediaType: "text" }])).toBe("");
		expect(buildImageInjectedNotice(undefined)).toBe("");
	});
});

/**
 * 2026-11-15 生产事故回归锁：长文本粘贴成 T* 芯片后，
 * 模型把 `T1=<前 200 字>` 读成「任务背景描述」，连答三次「没有附件」并误调 read_media。
 * 判据必须是**行为级**：点名行是否真进了 prompt 块、是否在素材行之前、是否给出取全文的工具名。
 */
describe("长文本素材的「文档已附加」点名（模型接住文档）", () => {
	const longDoc = "我在做一个创作的agent，".repeat(80); // 明显超 200 字

	it("超 200 字：块头点名这是附加文档、给字数、要求先 read_document(ref:\"T1\")", () => {
		const block = buildSidebarBlock([{ text: longDoc, mediaType: "text" }]);
		expect(block).toContain("【文档已附加】");
		expect(block).toContain("不是背景说明");
		expect(block).toContain('read_document(ref:"T1")');
		expect(block).toContain(`共 ${[...longDoc].length} 字`);
		expect(block).toContain("不得仅凭预览断言「没有附件」");
	});

	it("点名行必须在素材行之前（生产思考记录实证：先读预览会把文档当背景）", () => {
		const block = buildSidebarBlock([{ text: longDoc, mediaType: "text" }]);
		expect(block.indexOf("【文档已附加】")).toBeLessThan(block.indexOf("T1=" + longDoc.slice(0, 200)));
		expect(block.startsWith("侧栏参考素材：\n【文档已附加】")).toBe(true);
	});

	it("短文本 / 图片 / 音视频：零噪声，块内容与点名前逐字一致", () => {
		expect(buildSidebarBlock([{ text: "产品文案草稿", mediaType: "text" }])).toBe(
			"侧栏参考素材：\nT1=产品文案草稿",
		);
		const mediaOnly = buildSidebarBlock([
			{ url: "https://cdn.x/a/b.png?sign=1", mediaType: "image" },
			{ url: "https://x/v.mp4", mediaType: "video" },
			{ url: "https://x/a.mp3", mediaType: "audio" },
		]);
		expect(mediaOnly).not.toContain("【文档已附加】");
		expect(mediaOnly).not.toContain("read_document");
	});

	it("多文档：每个 T* 各自点名，refKey 不串位；图片行不背文档指令", () => {
		const block = buildSidebarBlock([
			{ url: "https://x/a.png", mediaType: "image" },
			{ text: longDoc, mediaType: "text" },
			{ text: "第二篇" + longDoc, mediaType: "text" },
		]);
		expect(block).toContain('read_document(ref:"T1")');
		expect(block).toContain('read_document(ref:"T2")');
		expect(block).not.toContain('read_document(ref:"I1")');
		expect(block).toContain("I1=a.png url=https://x/a.png");
	});

	it("点名行进的是动态块，不触碰 L6 静态预算（块体仍以「侧栏参考素材」开头）", () => {
		const block = buildSidebarBlock([{ text: longDoc, mediaType: "text" }]);
		expect(block.startsWith("侧栏参考素材")).toBe(true);
		expect(block.length).toBeLessThan(2000);
	});
});
