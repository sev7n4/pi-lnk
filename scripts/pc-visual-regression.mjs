#!/usr/bin/env node
/**
 * PC 会话页自动化视觉回归采集（SSE 母规格 Phase 4 删除刀的准入护栏）。
 *
 * 契约 SSOT: docs/ops/2026-11-09-pc-visual-regression-runbook.md
 * 规格:      docs/superpowers/specs/2026-11-09-pc-visual-regression-harness-design.md
 *
 * 硬性约束:
 *  - 地址 / 端口 / 截图目录 / 基线路径 / Chrome 路径全部来自 env，仓库内无字面量生产地址。
 *  - 三条 PREFLIGHT 先于任何采集；禁 session-scoped 视口修正。
 *  - 判据是结构 + 几何 + 白名单计算样式的 JSON 基线 diff；PNG 仅作目视附件，不进退出码。
 *  - 不挂 CI、不连生产、不写数据库；golden baseline 只读，删除刀不得修改。
 */
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const STYLE_ALLOWLIST = [
  'display', 'position', 'visibility', 'fontSize', 'fontWeight',
  'color', 'backgroundColor', 'overflowX', 'overflowY', 'boxSizing',
]

const REQUIRED_ENV = ['LNKPI_PC_BASE_URL', 'LNKPI_PC_CDP_PORT', 'LNKPI_PC_SHOT_DIR']

// ---------------------------------------------------------------- config ----

export function readConfig(env) {
  const missing = REQUIRED_ENV.filter((k) => !env[k])
  if (missing.length) throw new Error('missing required env: ' + missing.join(', '))
  const num = (k, d) => {
    const v = Number(env[k] ?? d)
    if (!Number.isFinite(v) || v <= 0) throw new Error('invalid numeric env: ' + k)
    return v
  }
  return {
    base: env.LNKPI_PC_BASE_URL.replace(/\/$/, ''),
    cdpHost: '127.0.0.1',
    cdpPort: num('LNKPI_PC_CDP_PORT', 9224),
    shotDir: env.LNKPI_PC_SHOT_DIR,
    baseline: env.LNKPI_PC_BASELINE ?? join(ROOT, 'scripts/baselines/pc-visual-baseline.json'),
    fixturePage: env.LNKPI_PC_FIXTURE_PAGE ?? 'pc-visual-page.html',
    width: num('LNKPI_PC_VIEWPORT_WIDTH', 1440),
    height: num('LNKPI_PC_VIEWPORT_HEIGHT', 900),
    minPcWidth: num('LNKPI_MIN_PC_WIDTH', 767),
    chrome: env.LNKPI_PC_CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  }
}

// ------------------------------------------------------------ pure helpers ----

export function normalizeSnapshot(raw) {
  const round = (v) => Math.round(Number(v) || 0)
  return {
    schema: 'lnkpi.pc-visual.snapshot.v1',
    viewport: { w: round(raw?.viewport?.w), h: round(raw?.viewport?.h) },
    elements: (raw?.elements ?? []).map((e) => ({
      tag: String(e.tag ?? ''),
      cls: [...new Set(e.cls ?? [])].sort(),
      testid: String(e.testid ?? ''),
      textLen: round(e.textLen),
      x: round(e.x), y: round(e.y), w: round(e.w), h: round(e.h),
      styles: Object.fromEntries(STYLE_ALLOWLIST.map((k) => [k, String(e.styles?.[k] ?? '')])),
    })),
  }
}

export function diffSnapshots(golden, current) {
  const out = []
  const g = golden?.elements ?? []
  const c = current?.elements ?? []
  const n = Math.max(g.length, c.length)
  for (let i = 0; i < n; i++) {
    if (i >= g.length) {
      out.push({ kind: 'added', path: `elements[${i}]`, current: c[i] })
      continue
    }
    if (i >= c.length) {
      out.push({ kind: 'missing', path: `elements[${i}]`, golden: g[i] })
      continue
    }
    if (JSON.stringify(g[i]) !== JSON.stringify(c[i])) {
      out.push({ kind: 'changed', path: `elements[${i}]`, golden: g[i], current: c[i] })
    }
  }
  if (JSON.stringify(golden?.viewport) !== JSON.stringify(current?.viewport)) {
    out.push({ kind: 'changed', path: 'viewport', golden: golden?.viewport, current: current?.viewport })
  }
  return out
}

export function evaluateVerdict(determinismOk, diff, checks) {
  const passCount = checks.filter((c) => c.status === 'PASS').length
  const failCount = checks.filter((c) => c.status === 'FAIL').length
  return {
    ok: determinismOk && diff.length === 0 && failCount === 0 && passCount === checks.length,
    passCount,
    failCount,
  }
}

export function stableStringify(snapshot) {
  return JSON.stringify(snapshot, null, 2) + '\n'
}

export function sha256(text) {
  return createHash('sha256').update(text).digest('hex')
}

// -------------------------------------------------------------------- cdp ----

class Cdp {
  constructor(wsUrl) { this.wsUrl = wsUrl; this.events = []; this.seq = 0; this.pending = new Map() }
  async open() {
    this.ws = new WebSocket(this.wsUrl)
    await new Promise((res, rej) => { this.ws.onopen = res; this.ws.onerror = rej })
    this.ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data)
      if (m.id && this.pending.has(m.id)) {
        const { res, rej } = this.pending.get(m.id)
        this.pending.delete(m.id)
        m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result)
      } else if (m.method) this.events.push(m)
    }
  }
  send(method, params = {}) {
    return new Promise((res, rej) => {
      const id = ++this.seq
      this.pending.set(id, { res, rej })
      this.ws.send(JSON.stringify({ id, method, params }))
      setTimeout(() => {
        if (this.pending.has(id)) { this.pending.delete(id); rej(new Error('CDP timeout: ' + method)) }
      }, 30000)
    })
  }
  async evalJs(expression) {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 400))
    return r.result.value
  }
  seen(method) { return this.events.some((e) => e.method === method) }
  close() { try { this.ws.close() } catch {} }
}

function launchChrome(cfg) {
  const profile = mkdtempSync(join(tmpdir(), 'lnkpi-pc-visual-'))
  const child = spawn(cfg.chrome, [
    '--headless=new',
    '--no-sandbox',
    '--disable-gpu',
    '--no-proxy-server',
    '--hide-scrollbars',
    '--no-first-run',
    '--no-default-browser-check',
    '--force-device-scale-factor=1',
    '--remote-debugging-port=' + cfg.cdpPort,
    '--user-data-dir=' + profile,
    'about:blank',
  ], { stdio: 'ignore' })
  return child
}

async function waitForCdp(api) {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(api + '/json/version')
      if (r.ok) return await r.json()
    } catch {}
    await sleep(300)
  }
  throw new Error('P0 FAILED: CDP endpoint did not start')
}

// -------------------------------------------------------------- preflight ----

export async function runPreflight(cfg) {
  const api = `http://${cfg.cdpHost}:${cfg.cdpPort}`
  const version = await waitForCdp(api)
  console.log('PREFLIGHT chrome=' + version.Browser + ' cdp=' + cfg.cdpHost + ':' + cfg.cdpPort)

  // P2 — 同一 fixture 页的残留 tab 清理到唯一，避免串台。
  let list = await (await fetch(api + '/json/list')).json()
  const matched = list.filter((t) => (t.url || '').includes(cfg.fixturePage))
  for (const t of matched.slice(1)) await fetch(api + '/json/close/' + t.id)
  list = await (await fetch(api + '/json/list')).json()
  const after = list.filter((t) => (t.url || '').includes(cfg.fixturePage))
  if (after.length > 1) throw new Error('P2 FAILED: duplicate fixture tabs remain')
  let tab = after[0] ?? list.find((t) => t.type === 'page')
  if (!tab) tab = await (await fetch(api + '/json/new?about:blank', { method: 'PUT' })).json()
  console.log('PREFLIGHT P2 PASS closed=' + Math.max(0, matched.length - 1) + ' tab=' + tab.id)

  // P1 — browser 级窗口修正，随后用全新 session 复核持久性。
  const w1 = new Cdp(tab.webSocketDebuggerUrl)
  await w1.open()
  const info = await w1.send('Browser.getWindowForTarget', {})
  await w1.send('Browser.setWindowBounds', {
    windowId: info.windowId,
    bounds: { width: cfg.width, height: cfg.height },
  })
  w1.close()
  await sleep(1200)
  const w2 = new Cdp(tab.webSocketDebuggerUrl)
  await w2.open()
  const probe1 = JSON.parse(await w2.evalJs('JSON.stringify({innerWidth:innerWidth,innerHeight:innerHeight})'))
  w2.close()
  if (!(probe1.innerWidth >= cfg.minPcWidth)) {
    throw new Error('P1 FAILED: browser-level bounds did not persist, innerWidth=' + probe1.innerWidth)
  }
  console.log('PREFLIGHT P1 PASS innerWidth=' + probe1.innerWidth + ' min=' + cfg.minPcWidth)

  // P3 — 打开 fixture 页，断言 PC 布局与真实组件渲染；移动端断点直接 FAIL。
  const cdp = new Cdp(tab.webSocketDebuggerUrl)
  await cdp.open()
  for (const m of ['Page.enable', 'Runtime.enable', 'Log.enable', 'Network.enable']) await cdp.send(m)
  await cdp.send('Page.navigate', { url: cfg.base })
  let ready = false
  for (let i = 0; i < 60 && !ready; i++) {
    await sleep(300)
    ready = await cdp.evalJs('Boolean(window.__PC_VISUAL_READY__)').catch(() => false)
  }
  if (!ready) throw new Error('P3 FAILED: fixture page never became ready')
  const probe = JSON.parse(await cdp.evalJs(`JSON.stringify((() => {
    const shell = document.querySelector('.pc-dock-shell');
    const root = document.querySelector('[data-pc-visual-root]');
    return {
      innerWidth: innerWidth,
      innerHeight: innerHeight,
      shellPresent: !!shell,
      rootPresent: !!root,
      hostCount: document.querySelectorAll('[data-testid="agent-presentation-host"]').length,
      nodeCount: root ? root.querySelectorAll('*').length : 0,
      href: location.href,
    };
  })())`))
  if (!(probe.innerWidth >= cfg.minPcWidth) || !probe.shellPresent || !probe.rootPresent ||
      probe.hostCount < 1 || probe.nodeCount < 5) {
    throw new Error('P3 FAILED: PC layout or real presentation render missing, ' + JSON.stringify(probe))
  }
  console.log('PREFLIGHT P3 PASS innerWidth=' + probe.innerWidth + ' hosts=' + probe.hostCount +
    ' nodes=' + probe.nodeCount)
  return cdp
}

// ---------------------------------------------------------------- capture ----

const SETTLE_EXPR = `(async () => {
  await document.fonts.ready;
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  return true;
})()`

const CAPTURE_EXPR = `JSON.stringify((() => {
  const root = document.querySelector('[data-pc-visual-root]');
  if (!root) return { error: 'missing pc visual root' };
  const styleKeys = ${JSON.stringify(STYLE_ALLOWLIST)};
  const nodes = [root, ...root.querySelectorAll('*')];
  return {
    viewport: { w: innerWidth, h: innerHeight },
    elements: nodes.map((el) => {
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      const styles = {};
      for (const k of styleKeys) styles[k] = cs[k];
      return {
        tag: el.tagName.toLowerCase(),
        cls: [...el.classList],
        testid: el.getAttribute('data-testid') || '',
        textLen: (el.textContent || '').trim().length,
        x: r.x, y: r.y, w: r.width, h: r.height,
        styles: styles,
      };
    }),
  };
})())`

export async function captureSnapshot(cdp, cfg) {
  await cdp.evalJs(SETTLE_EXPR)
  const raw = JSON.parse(await cdp.evalJs(CAPTURE_EXPR))
  if (raw.error) throw new Error('capture failed: ' + raw.error)
  const snapshot = normalizeSnapshot(raw)
  if (snapshot.elements.length < 5) throw new Error('capture failed: too few elements')
  return snapshot
}

// ------------------------------------------------------------------- main ----

export async function main() {
  const cfg = readConfig(process.env)
  const chrome = launchChrome(cfg)
  let cdp = null
  try {
    cdp = await runPreflight(cfg)
    const snapA = await captureSnapshot(cdp, cfg)
    const snapB = await captureSnapshot(cdp, cfg)
    const textA = stableStringify(snapA)
    const textB = stableStringify(snapB)
    const shaA = sha256(textA)
    const shaB = sha256(textB)
    const determinismOk = shaA === shaB
    if (shaA !== shaB) {
      console.log('DETERMINISM_FAIL shaA=' + shaA + ' shaB=' + shaB)
    } else {
      console.log('DETERMINISM_OK sha256=' + shaA)
    }

    if (!existsSync(cfg.baseline)) throw new Error('golden baseline missing: ' + cfg.baseline)
    const golden = normalizeSnapshot(JSON.parse(readFileSync(cfg.baseline, 'utf8')))
    const diff = diffSnapshots(golden, snapB)

    mkdirSync(cfg.shotDir, { recursive: true })
    writeFileSync(join(cfg.shotDir, 'pc-visual-current.json'), textB)
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' })
    const shotPath = join(cfg.shotDir, 'pc-visual-current.png')
    writeFileSync(shotPath, Buffer.from(shot.data, 'base64'))

    const checks = [
      { id: 'PREFLIGHT', status: 'PASS' },
      { id: 'REAL_COMPONENT_RENDER', status: snapB.elements.length >= 5 ? 'PASS' : 'FAIL' },
      { id: 'DETERMINISM', status: determinismOk ? 'PASS' : 'FAIL' },
      { id: 'BASELINE_DIFF', status: diff.length === 0 ? 'PASS' : 'FAIL' },
    ]
    const verdict = evaluateVerdict(determinismOk, diff, checks)
    console.log('diff_count=' + diff.length)
    for (const d of diff.slice(0, 8)) console.log('DIFF ' + d.kind + ' ' + d.path)
    console.log('PNG ' + shotPath)
    console.log('SHOT_DIR ' + cfg.shotDir)
    console.log('SHA_A ' + shaA)
    console.log('SHA_B ' + shaB)
    console.log('VERDICT ' + (verdict.ok ? 'ALL_PASS' : 'HAS_FAILURE') +
      ' pass=' + verdict.passCount + ' fail=' + verdict.failCount)
    process.exitCode = verdict.ok ? 0 : 1
  } finally {
    if (cdp) cdp.close()
    chrome.kill('SIGTERM')
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main().catch((e) => { console.error('FATAL ' + (e?.stack || e)); process.exitCode = 1 })
}
