/**
 * 提示词注册中心门禁（spec §4.5 的 L0-L11）。
 *
 * 刻意只做 CLI 外壳：全部判据在 loader 的 checkRegistryIntegrity 里，
 * 运行时与 CI 共用同一份，避免"本地过、线上炸"。
 *
 * errors → 退出码 1（阻断）；warnings → 打印但不阻断（当前只有 L6 预算预警）。
 *
 * 运行：pnpm prompt:lint（等价于 npx tsx scripts/prompt-lint.ts）
 */
import {
	checkRegistryIntegrity,
	resolveRegistryRoot,
} from "../apps/server/src/agent/pi-runtime/prompt-registry.loader";

// lint 跑在仓库根，cwd 一定是根；env 显式指定时以它为准。
const root = process.env.PI_PROMPT_REGISTRY_DIR ?? resolveRegistryRoot();
const { errors, warnings } = checkRegistryIntegrity(root);

// 预警先于错误打印：错误退出码 1 时 stdout 仍会被看到，混在后面的预警才不丢。
for (const w of warnings) console.warn(`prompt-lint: [warn] ${w}`);

if (errors.length > 0) {
	for (const e of errors) console.error(`prompt-lint: ${e}`);
	console.error(`prompt-lint: ${errors.length} 个问题 → 退出码 1`);
	process.exit(1);
}
console.log(`prompt-lint: ok (${root})${warnings.length ? `，${warnings.length} 条预警` : ""}`);
