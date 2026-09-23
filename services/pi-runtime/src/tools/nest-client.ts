/**
 * Nest HTTP 转发层（P1-④）。契约对齐老 runtime nest_client.py：
 * POST JSON + x-lnkpi-service-token 头 + {code,message,data} 包络 +
 * per-path 熔断（5 次/60s）+ 按路径超时（默认 10s；image 210s / video 690s 预留）。
 * 零依赖：fetch + AbortSignal.timeout。
 */
export interface NestClientOptions {
	baseUrl: string;
	token: string;
	fetchImpl?: typeof fetch;
	defaultTimeoutMs?: number;
	/** 按路径前缀覆盖超时，如 { "/agent/internal/run-video": 690_000 }（后续批次用）。 */
	timeoutOverrides?: Record<string, number>;
	breakerThreshold?: number;
	breakerCooldownMs?: number;
	onCall?: (pathTail: string, outcome: "ok" | "error" | "circuit_open") => void;
}

export class NestToolError extends Error {
	constructor(
		message: string,
		readonly kind: "http" | "envelope" | "timeout",
	) {
		super(message);
	}
}
export class NestCircuitOpenError extends Error {}

interface BreakerState {
	failures: number;
	openUntil: number;
}

const pathTail = (p: string) => p.split("/").pop() ?? p;
/** metrics 标签统一 snake_case（对齐老 runtime 工具名，如 get_canvas_summary）。 */
const toolLabel = (p: string) => pathTail(p).replace(/-/g, "_");

export class NestClient {
	private readonly breaker = new Map<string, BreakerState>();
	private readonly fetchImpl: typeof fetch;
	private readonly defaultTimeoutMs: number;
	private readonly threshold: number;
	private readonly cooldownMs: number;

	constructor(private readonly opts: NestClientOptions) {
		this.fetchImpl = opts.fetchImpl ?? fetch;
		this.defaultTimeoutMs = opts.defaultTimeoutMs ?? 10_000;
		this.threshold = opts.breakerThreshold ?? 5;
		this.cooldownMs = opts.breakerCooldownMs ?? 60_000;
	}

	private timeoutMsFor(path: string): number {
		for (const [prefix, ms] of Object.entries(this.opts.timeoutOverrides ?? {})) {
			if (path.startsWith(prefix)) return ms;
		}
		return this.defaultTimeoutMs;
	}

	private checkCircuit(path: string): void {
		const st = this.breaker.get(path);
		if (st && st.openUntil > Date.now()) throw new NestCircuitOpenError(`circuit open for ${path}`);
	}

	private recordSuccess(path: string): void {
		this.breaker.delete(path);
	}

	private recordFailure(path: string): void {
		const st = this.breaker.get(path) ?? { failures: 0, openUntil: 0 };
		st.failures += 1;
		if (st.failures >= this.threshold) {
			st.openUntil = Date.now() + this.cooldownMs;
			st.failures = 0;
		}
		this.breaker.set(path, st);
	}

	async post(path: string, body: unknown): Promise<unknown> {
		try {
			this.checkCircuit(path);
		} catch (err) {
			this.opts.onCall?.(toolLabel(path), "circuit_open");
			throw err;
		}
		const timeoutMs = this.timeoutMsFor(path);
		try {
			const res = await this.fetchImpl(`${this.opts.baseUrl}${path}`, {
				method: "POST",
				headers: { "content-type": "application/json", "x-lnkpi-service-token": this.opts.token },
				body: JSON.stringify(body),
				signal: AbortSignal.timeout(timeoutMs),
			});
			const payload = (await res.json().catch(() => null)) as
				| { code?: number; message?: string; data?: unknown }
				| null;
			if (!res.ok) {
				// 熔断只对"服务不可用"类失败计数（5xx/超时/网络），4xx 属业务错误不计（对齐老 runtime）
				if (res.status >= 500) this.recordFailure(path);
				this.opts.onCall?.(toolLabel(path), "error");
				throw new NestToolError(
					`nest ${path} http ${res.status}: ${payload?.message ?? res.statusText}`,
					"http",
				);
			}
			if (!payload || payload.code !== 0) {
				// HTTP 200 但包络错误 = 业务错误，不计熔断（避免模型连续用错参数把工具熔死）
				this.opts.onCall?.(toolLabel(path), "error");
				throw new NestToolError(
					`nest ${path} code=${payload?.code}: ${payload?.message ?? "empty envelope"}`,
					"envelope",
				);
			}
			this.recordSuccess(path);
			this.opts.onCall?.(toolLabel(path), "ok");
			return payload.data;
		} catch (err) {
			if (err instanceof NestToolError || err instanceof NestCircuitOpenError) throw err;
			const isTimeout = err instanceof Error && err.name === "TimeoutError";
			this.recordFailure(path);
			this.opts.onCall?.(toolLabel(path), "error");
			throw new NestToolError(
				`nest ${path} ${isTimeout ? "timeout after " + timeoutMs + "ms" : "network error"}: ${err instanceof Error ? err.message : String(err)}`,
				isTimeout ? "timeout" : "http",
			);
		}
	}
}

export interface NestConfig {
	baseUrl: string;
	token: string;
	breakerThreshold?: number;
	breakerCooldownMs?: number;
}

const readPositiveInt = (v: string | undefined): number | undefined => {
	if (!v) return undefined;
	const n = Number(v);
	return Number.isInteger(n) && n > 0 ? n : undefined;
};

export function loadNestConfig(): NestConfig | null {
	const baseUrl = process.env.NEST_BASE_URL;
	const token = process.env.NEST_SERVICE_TOKEN;
	if (!baseUrl || !token) return null;
	const threshold = readPositiveInt(process.env.NEST_BREAKER_THRESHOLD);
	const cooldownMs = readPositiveInt(process.env.NEST_BREAKER_COOLDOWN_MS);
	return {
		baseUrl,
		token,
		...(threshold !== undefined ? { breakerThreshold: threshold } : {}),
		...(cooldownMs !== undefined ? { breakerCooldownMs: cooldownMs } : {}),
	};
}
