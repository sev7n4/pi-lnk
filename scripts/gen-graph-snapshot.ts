/**
 * 重新生成 render_canvas_view 的黄金快照基线。
 *
 * ⚠️ 这是**会改基线**的入口：只在明确要接受新的输出时跑（D3 的三个任务各跑一次，
 * 并在提交信息里写明 diff 摘要）。D2 阶段（纯重构）跑它就是承认行为变了。
 */
import { execSync } from "node:child_process";
import { captureGolden, saveGolden } from "../services/pi-runtime/src/graph/snapshot.js";

// 根 package.json 没有 "type": "module" ⇒ tsx 以 cjs 输出，顶层 await 不可用。
async function main(): Promise<void> {
	const commit = execSync("git rev-parse HEAD").toString().trim();
	const g = await captureGolden(commit);
	saveGolden(g);
	console.log(`写入 ${g.cases.length} 个用例，commit=${commit}`);
}

main().catch((e: unknown) => {
	console.error(e);
	process.exit(1);
});
