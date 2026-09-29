/** 视觉自评闭环（spec 2026-09-29 §4.2）：生成图 → image block 回流。fail-open：任何失败只降级不抛错。 */
export interface ImageBlock { type: "image"; data: string; mimeType: string }
export type ImageFetchResult =
	| { ok: true; block: ImageBlock }
	| { ok: false; reason: "disabled" | "empty-url" | "timeout" | "network" | "http" | "mime" | "too-large" };

const ALLOWED_MIMES: ReadonlySet<string> = new Set(["image/png", "image/jpeg", "image/webp"]);
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 15_000;

export function isImageRefineEnabled(): boolean {
	return (process.env.PI_RUNTIME_IMAGE_REFINE ?? "on").toLowerCase() !== "off";
}

export async function fetchImageAsBlock(
	url: string,
	deps: { fetchImpl?: typeof fetch; maxBytes?: number; timeoutMs?: number } = {},
): Promise<ImageFetchResult> {
	if (!isImageRefineEnabled()) return { ok: false, reason: "disabled" };
	if (!url) return { ok: false, reason: "empty-url" };
	const maxBytes = deps.maxBytes ?? DEFAULT_MAX_BYTES;
	const fetchImpl = deps.fetchImpl ?? fetch;
	try {
		const res = await fetchImpl(url, { signal: AbortSignal.timeout(deps.timeoutMs ?? DEFAULT_TIMEOUT_MS) });
		if (!res.ok) return { ok: false, reason: "http" };
		const mime = (res.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
		if (!ALLOWED_MIMES.has(mime)) return { ok: false, reason: "mime" };
		const declared = Number(res.headers.get("content-length") ?? "");
		if (Number.isFinite(declared) && declared > maxBytes) return { ok: false, reason: "too-large" };
		const chunks: Uint8Array[] = [];
		let total = 0;
		if (res.body) {
			for await (const chunk of res.body) {
				const buf = chunk as Uint8Array;
				total += buf.byteLength;
				if (total > maxBytes) return { ok: false, reason: "too-large" };
				chunks.push(buf);
			}
		}
		return { ok: true, block: { type: "image", data: Buffer.concat(chunks).toString("base64"), mimeType: mime } };
	} catch (err) {
		const isTimeout = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
		return { ok: false, reason: isTimeout ? "timeout" : "network" };
	}
}
