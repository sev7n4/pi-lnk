/**
 * hook event 自由形态字段的读取守卫。
 *
 * 为什么需要它
 * ----------
 * `harness.hooks.on(name, (event) => ...)` 的 event 参数是泛型推断出来的，
 * 所以「字段名被上游改掉」这件事 tsc 能抓到（见 scripts/verify-tool-contract.ts
 * 的静态门禁）。但字段**形态**是另一回事：
 *
 * - `after_tool.details` 是 `JsonValue`（上游不保证结构）
 * - `before_payload.payload` 是 `unknown`
 * - `before_tool/after_tool.args` 是 `Record<string, JsonValue>`
 *
 * 这三处原本靠 `as` 强转后直接取属性。一旦上游换了形态，读到的就是 `undefined`，
 * 代码沿「没这个字段」的分支走下去 —— 不报错、不告警、指标上也看不出来。
 * 这就是静默降级：请求 200、无 error、功能悄悄没了。
 *
 * 更糟的一种：`{ ...(event.payload as Record<string, unknown>), messages }` 在
 * payload 为 null / 字符串时会展开成 `{}`，于是整份 payload 除 messages 外的
 * 字段被静默丢掉，且调用方拿到的仍是一个「看起来正常」的对象。
 *
 * 本模块把这三处读法改成显式解析：失败时返回可判读的 reason，由调用方决定
 * 是留痕还是放行 —— 失败不再伪装成「字段不存在」。
 *
 * 边界：本模块只做读取与判读，不改变任何业务语义（放行/拦截的决策仍在调用方）。
 */

/** 读取结果：ok=true 带值；ok=false 带可判读的理由（供日志 / 断言使用）。 */
export type FieldRead<T> = { ok: true; value: T } | { ok: false; reason: string }

/**
 * 把 unknown / JsonValue 判读成对象。
 * 拒绝 null、undefined、数组、原始类型 —— 这几类在 `as Record<...>` 之后
 * 都会静默产出「空对象语义」，是静默丢字段的来源。
 */
export function readRecord(value: unknown, path: string): FieldRead<Record<string, unknown>> {
	if (value === null || value === undefined) {
		return { ok: false, reason: `${path}: is ${String(value)}, expected object` }
	}
	if (typeof value !== 'object') {
		return { ok: false, reason: `${path}: is ${typeof value}, expected object` }
	}
	if (Array.isArray(value)) {
		return { ok: false, reason: `${path}: is array, expected object` }
	}
	return { ok: true, value: value as Record<string, unknown> }
}

/** 从对象里读非空字符串字段（args.node_id 这类）。 */
export function readStringField(source: unknown, field: string, path: string): FieldRead<string> {
	const obj = readRecord(source, path)
	if (!obj.ok) return obj
	const raw: unknown = obj.value[field]
	if (typeof raw !== 'string' || raw.length === 0) {
		return { ok: false, reason: `${path}.${field}: missing or not a non-empty string` }
	}
	return { ok: true, value: raw }
}

/** 从对象里读布尔字段（details.confirmed 这类）。缺失 ≠ false，两者都要能区分。 */
export function readBooleanField(source: unknown, field: string, path: string): FieldRead<boolean> {
	const obj = readRecord(source, path)
	if (!obj.ok) return obj
	const raw: unknown = obj.value[field]
	if (typeof raw !== 'boolean') {
		return { ok: false, reason: `${path}.${field}: missing or not a boolean` }
	}
	return { ok: true, value: raw }
}
