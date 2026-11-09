const STORAGE_KEY = 'lnkpi.canvas.clientId'

export interface CanvasClientIdDeps {
  storage?: Pick<Storage, 'getItem' | 'setItem'>
  random?: () => string
}

/** 观测专用 per-tab 标识。不参与鉴权、不进画布数据、异常一律降级。 */
export function getCanvasClientId(deps: CanvasClientIdDeps = {}): string {
  const storage = 'storage' in deps
    ? deps.storage
    : (typeof sessionStorage === 'undefined' ? null : sessionStorage)
  const random =
    deps.random ??
    (() => globalThis.crypto?.randomUUID?.() ?? `c-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  if (!storage) return 'unknown'
  try {
    const existing = storage.getItem(STORAGE_KEY)
    if (existing) return existing
    const id = random()
    storage.setItem(STORAGE_KEY, id)
    return id
  } catch {
    return 'unknown'
  }
}
