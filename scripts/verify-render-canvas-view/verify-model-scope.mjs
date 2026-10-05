#!/usr/bin/env node
/**
 * 生产复测②：走**真实模型链路**验「模型能否自主选对 scope / focus」。
 *
 * 复测① 验「工具能产出正确」；这轮验「用户换个问法，模型会不会选对」——
 * 这是唯一无法用单测覆盖的一环（参数选错工具照样能跑，只是答非所问）。
 *
 * 跑在 pi-runtime pod 内：
 *   node verify-model-scope.mjs <canvasId>
 *
 * ⚠️ 本文件头部的五条契约全部来自 docs/agent/architecture.md 的
 *    「直连 pi-runtime 复测：SSE 契约」章节 —— 踩任意一条都会得到「事件数 0」，
 *    而它与「工具全404」的现象看起来完全一样，极易误判成「功能失效」。
 */
import http from "node:http";

const CANVAS = process.argv[2];
if (!CANVAS) {
	console.error("用法: node verify-model-scope.mjs <canvasId>");
	process.exit(2);
}
const PORT = 8100; // ⚠️ pod 内用 8100；30100 是 NodePort，pod 内不可达

const SYSTEM_PROMPT = [
	"你在画布助手里工作，当前画布是一个剧本制作项目。",
	"",
	"工具：",
	"- get_canvas_layout：读画布。节点含 id / type(prompt|image|video) / title / status / position / parentNode",
	"- render_canvas_view：把画布渲染成 SVG 卡片给人看",
	"",
	"render_canvas_view 的 view 选择：",
	"- layout=依赖图（谁依赖谁）· tree=层级 · timeline=顺序 · swimlane=泳道 · matrix=交叉表",
	"",
	"scope（观察尺度，layout 下的关键选择）：",
	"- scope=structure（默认）：只画骨架，即 prompt→prompt 的边（大纲→各集）。讲原理、看整体结构时用",
	"- scope=ownership：骨架 + prompt→素材 的边（素材属于哪一集）。问归属时用",
	"- scope=detail：全部边，含素材之间的（镜头顺序）。只在你明确要精确到每条边时用",
	"",
	"focus（拆局部）：",
	"- focus=<节点id> 只画该节点的 hops 跳邻域。detail 在大画布上会超预算，此时必须用 focus。",
	"",
	"判断示例：",
	"- 「讲讲整体结构 / 为什么这么搭」→ scope=structure",
	"- 「每集都做了什么、素材怎么分布」→ scope=ownership",
	"- 「EP01 具体有哪些素材、分别连到哪个视频」→ scope=detail + focus=<EP01 或资产表的节点id>",
].join("\n");

const QUESTIONS = [
	{ q: "讲讲这个画布的整体结构，为什么这么搭", want: { scope: "structure" } },
	{ q: "每个 EP 的素材是怎么分布的", want: { scope: "ownership" } },
	{ q: "EP01 具体有哪些素材，各自连到哪个视频", want: { scope: "detail", focus: true } },
];

function post(path, body) {
	return new Promise((resolve) => {
		const data = JSON.stringify(body);
		const req = http.request(
			{ host: "127.0.0.1", port: PORT, path, method: "POST",
				headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) } },
			(r) => {
				let d = "";
				r.on("data", (c) => (d += c));
				r.on("end", () => resolve({ status: r.statusCode, text: d }));
			},
		);
		req.on("error", (e) => resolve({ status: 0, text: String(e.message) }));
		req.write(data);
		req.end();
	});
}

/**
 * 订阅 SSE。帧格式：`id: <seq>\nevent: <type>\ndata: <JSON>\n\n`
 * ⚠️ 必须 `?from=now` —— 不带会落replay(afterSeq=-1)，buffer 溢出时服务端回 409。
 * ⚠️ 必须**先订阅再 POST prompt**，反过来会漏事件。
 */
function subscribeEvents(sessionId) {
	return new Promise((resolve) => {
		const state = { tools: [], texts: [], events: 0, ended: false, error: null, subscribed: false, toolKeys: "" };
		const req = http.request(
			{ host: "127.0.0.1", port: PORT, path: `/sessions/${sessionId}/events?from=now`, method: "GET",
				headers: { Accept: "text/event-stream" } },
			(res) => {
				if (res.statusCode !== 200) {
					res.resume();
					state.error = "HTTP " + res.statusCode;
					resolve(state);
					return;
				}
				state.subscribed = true;
				let buf = "";
				res.on("data", (c) => {
					buf += c.toString();
					let idx;
					while ((idx = buf.indexOf("\n\n")) >= 0) {
						const raw = buf.slice(0, idx);
						buf = buf.slice(idx + 2);
						let evType = "";
						let dataLine = "";
						for (const line of raw.split("\n")) {
							if (line.startsWith("event:")) evType = line.slice(6).trim();
							if (line.startsWith("data:")) dataLine = line.slice(5).trim();
						}
						if (!dataLine) continue;
						let ev;
						try { ev = JSON.parse(dataLine); } catch { continue; }
						state.events++;
						const d = ev.data || ev;
						if (d.toolName) {
							state.tools.push(d.toolName);
							if (!state.toolKeys) state.toolKeys = Object.keys(d).join(",");
						}
						if (evType === "agent_end" || d.type === "agent_end") state.ended = true;
						const msg = d.message;
						if (msg && Array.isArray(msg.content)) {
							for (const c2 of msg.content) if (c2.type === "text" && c2.text) state.texts.push(c2.text);
						}
					}
				});
				res.on("end", () => resolve(state));
			},
		);
		req.on("error", (e) => { state.error = String(e.message); resolve(state); });
		req.end();
		setTimeout(() => { try { req.destroy(); } catch { /* ignore */ } resolve(state); }, 180000);
	});
}

console.log(`\n════ 复测②：走模型链路验 scope 选择（画布 ${CANVAS}）════`);
console.log("⚠️ SSE 工具事件不含参数（只有 toolName+done）⇒ 只能验「调了哪些工具」；");
console.log("   要验模型选了什么参数，须另读 pod 内 /data/sessions/*/sessions/*/*.jsonl\n");

let pass = 0;
let sawTool = 0;
for (const item of QUESTIONS) {
	// 契约 1+2：必须带 canvasSessionId，响应字段是 sessionId
	const r = await post("/sessions", { sessionId: CANVAS, canvasSessionId: CANVAS, systemPrompt: SYSTEM_PROMPT });
	let sid;
	try {
		const j = JSON.parse(r.text);
		sid = j.sessionId || (j.data && j.data.sessionId);
	} catch { sid = undefined; }
	console.log(`【问】${item.q}`);
	if (!sid) {
		console.log(`   ✗ 建会话失败：${r.status} ${r.text.slice(0, 140)}\n`);
		continue;
	}
	// 契约 3+4：先订阅（?from=now）再 POST（body用 text）
	const stPromise = subscribeEvents(sid);
	await new Promise((r) => setTimeout(r, 400));
	const pr = await post(`/sessions/${sid}/prompt`, { text: item.q });
	const st = await stPromise;

	const unique = [...new Set(st.tools)];
	const viewCalls = st.tools.filter((n) => n.indexOf("render_canvas_view") >= 0).length;
	console.log(`   订阅=${st.subscribed} 事件=${st.events} ended=${st.ended} err=${st.error || "无"} prompt=${pr.status}`);
	console.log(`   工具：${unique.join(" → ")}`);
	console.log(`   render_canvas_view 调用 ${viewCalls} 次`);
	if (st.toolKeys) console.log(`   [实证] 工具事件字段：${st.toolKeys}  ← 无参数是已知设计`);

	if (viewCalls > 0) {
		sawTool++;
		// 参数层面只能靠 jsonl；这里只判「模型确实用工具画了图」
		pass++;
		console.log(`   ✓ 模型调用了 render_canvas_view（参数需查 jsonl）`);
	} else {
		console.log(`   ✗ 模型没调 render_canvas_view`);
	}
	if (st.texts.length) {
		console.log(`   模型答：${st.texts[st.texts.length - 1].replace(/\s+/g, " ").slice(0, 130)}…`);
	}
	console.log("");
}

console.log("────── 结论 ──────");
console.log(`${pass}/${QUESTIONS.length} 问法触发了 render_canvas_view`);
console.log("参数选择（scope/focus）请用 pod 内 jsonl 统计，命令见 architecture.md。");
process.exit(sawTool > 0 ? 0 : 1);
