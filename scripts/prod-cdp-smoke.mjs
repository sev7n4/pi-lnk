#!/usr/bin/env node
/**
 * 生产会话页 CDP 五层冒烟（参数化只读入口，路标 #4）。
 *
 * 契约 SSOT: docs/ops/2026-11-09-prod-cdp-smoke-runbook.md
 * 规格:      docs/superpowers/specs/2026-11-09-prod-cdp-smoke-runbook-design.md
 *
 * 硬性约束:
 *  - 生产地址 / 容器 / 端口 / 会话 id / JWT 来源全部来自 env，仓库内无字面量。
 *  - 三条 PREFLIGHT 先于任何判据，失败即 exit 1；禁 session-scoped 视口修正。
 *  - L3 真实回合默认 SKIPPED，只有 LNKPI_SMOKE_WRITE=1 才向生产写数据。
 *  - 不挂 CI；运行需要 SSH 私钥、容器内 JWT_SECRET 与本机 headless Chrome。
 */
import { execFileSync } from 'node:child_process'
import { createHmac } from 'node:crypto'
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const b64 = (data) => Buffer.from(data).toString('base64url').replace(/=+$/, '')

// ---------------------------------------------------------------- config ----

export function readConfig(env) {
  const required = ['LNKPI_BASE_URL', 'LNKPI_SESSION_ID', 'LNKPI_JWT_SUB']
  const missing = required.filter((k) => !env[k])
  if (missing.length) throw new Error('missing required env: ' + missing.join(', '))
  const num = (k, d) => {
    const v = Number(env[k] ?? d)
    if (!Number.isFinite(v) || v <= 0) throw new Error('invalid numeric env: ' + k)
    return v
  }
  return {
    base: env.LNKPI_BASE_URL.replace(/\/$/, ''),
    sessionId: env.LNKPI_SESSION_ID,
    sub: env.LNKPI_JWT_SUB,
    sshHost: env.LNKPI_SSH_HOST ?? 'deploy-cvm',
    apiContainer: env.LNKPI_API_CONTAINER ?? 'lnkpi-api',
    cdpHost: env.LNKPI_CDP_HOST ?? '127.0.0.1',
    cdpPort: num('LNKPI_CDP_PORT', 9223),
    width: num('LNKPI_VIEWPORT_WIDTH', 1440),
    height: num('LNKPI_VIEWPORT_HEIGHT', 900),
    minPcWidth: num('LNKPI_MIN_PC_WIDTH', 767),
    tokenFile: env.LNKPI_TOKEN_FILE ?? '/tmp/lnkpi-smoke-token',
    shotDir: env.LNKPI_SHOT_DIR ?? '/tmp/lnkpi-smoke-shots',
    write: env.LNKPI_SMOKE_WRITE === '1',
    probeText: env.LNKPI_PROBE_TEXT ?? '生产冒烟探针：请只回复一行纯文本 SMOKE-OK，不要生成图片，不要改动画布。',
    pollLimitMs: num('LNKPI_POLL_LIMIT_MS', 180000),
    shareId: env.LNKPI_SHARE_ID ?? '',
  }
}

export function mintJwt(cfg) {
  const secret = execFileSync('ssh', [
    '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=12', cfg.sshHost,
    'docker exec ' + cfg.apiContainer + ' printenv JWT_SECRET',
  ], { encoding: 'utf8' }).trim()
  if (secret.length < 32) throw new Error('JWT_SECRET unexpectedly short')
  const now = Math.floor(Date.now() / 1000)
  const header = b64(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
  const payload = b64(JSON.stringify({ sub: cfg.sub, iat: now, exp: now + 3600 }))
  const signingInput = header + '.' + payload
  const sig = createHmac('sha256', secret).update(signingInput).digest('base64url').replace(/=+$/, '')
  const token = signingInput + '.' + sig
  writeFileSync(cfg.tokenFile, token)
  chmodSync(cfg.tokenFile, 0o600)
  return token
}

export function dedupeTabs(list, sessionId) {
  const matched = (list || []).filter((t) => (t.url || '').includes('/workflow/' + sessionId))
  return { keep: matched[0] ?? null, close: matched.slice(1).map((t) => t.id) }
}

export function assertPcViewport(probe, minWidth) {
  const problems = []
  if (!(probe.innerWidth >= minWidth)) problems.push('innerWidth=' + probe.innerWidth + ' < ' + minWidth)
  if (probe.mobileShell !== false) problems.push('mobileShell=true')
  if (!probe.asidePresent) problems.push('aside.agent-side-rail missing')
  if (problems.length) throw new Error('PC viewport preflight FAILED: ' + problems.join('; '))
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

// -------------------------------------------------------------- preflight ----

export async function runPreflight(cfg, token) {
  const api = `http://${cfg.cdpHost}:${cfg.cdpPort}`
  const version = await (await fetch(api + '/json/version')).json()
  console.log('PREFLIGHT chrome=' + version.Browser + ' cdp=' + cfg.cdpHost + ':' + cfg.cdpPort)

  // P2 — 同 URL tab 清理到唯一，禁止裸 find 串台。
  let list = await (await fetch(api + '/json/list')).json()
  const { keep, close } = dedupeTabs(list, cfg.sessionId)
  for (const id of close) await fetch(api + '/json/close/' + id)
  list = await (await fetch(api + '/json/list')).json()
  const after = dedupeTabs(list, cfg.sessionId)
  if (after.close.length) throw new Error('P2 FAILED: duplicate workflow tabs remain')
  let tab = after.keep
  if (!tab) {
    tab = await (await fetch(api + '/json/new?about:blank', { method: 'PUT' })).json()
  }
  console.log('PREFLIGHT P2 PASS closed=' + close.length + ' tab=' + tab.id)

  // P1 — browser 级窗口修正，随后用全新 session 复核持久性。
  const w1 = new Cdp(tab.webSocketDebuggerUrl)
  await w1.open()
  const info = await w1.send('Browser.getWindowForTarget', {})
  await w1.send('Browser.setWindowBounds', {
    windowId: info.windowId,
    bounds: { width: cfg.width, height: cfg.height },
  })
  w1.close()
  await sleep(1500)
  const w2 = new Cdp(tab.webSocketDebuggerUrl)
  await w2.open()
  const widthProbe = JSON.parse(await w2.evalJs('JSON.stringify({innerWidth:innerWidth,innerHeight:innerHeight})'))
  w2.close()
  if (!(widthProbe.innerWidth >= cfg.minPcWidth)) {
    throw new Error('P1 FAILED: browser-level bounds did not persist, innerWidth=' + widthProbe.innerWidth)
  }
  console.log('PREFLIGHT P1 PASS innerWidth=' + widthProbe.innerWidth + ' min=' + cfg.minPcWidth)

  // P3 — 注入 token、打开会话页、断言 PC 布局；移动端壳层直接 FAIL，不静默换判据。
  const cdp = new Cdp(tab.webSocketDebuggerUrl)
  await cdp.open()
  for (const m of ['Page.enable', 'Runtime.enable', 'Log.enable', 'Network.enable']) await cdp.send(m)
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
    source: `try { localStorage.setItem('token', ${JSON.stringify(token)}); } catch (e) {}`,
  })
  await cdp.send('Page.navigate', { url: `${cfg.base}/workflow/${cfg.sessionId}` })
  for (let i = 0; i < 40 && !cdp.seen('Page.loadEventFired'); i++) await sleep(500)
  await sleep(7000)
  const probe = JSON.parse(await cdp.evalJs(`JSON.stringify((() => {
    const aside = document.querySelector('aside.agent-side-rail');
    const fab = document.querySelector('button.agent-fab');
    const shell = document.querySelector('.agent-panel-shell');
    return {
      innerWidth: innerWidth,
      mobileShell: innerWidth < 767 || (!aside && !fab),
      fabPresent: !!fab,
      asidePresent: !!aside,
      shellWidth: shell ? Math.round(shell.getBoundingClientRect().width) : -1,
      href: location.href,
    };
  })())`))
  assertPcViewport(probe, cfg.minPcWidth)
  const list2 = await (await fetch(api + '/json/list')).json()
  if (dedupeTabs(list2, cfg.sessionId).close.length) throw new Error('P2 FAILED: duplicate tabs after navigate')
  console.log('PREFLIGHT P3 PASS pcLayout=true fab=' + probe.fabPresent + ' aside=' + probe.asidePresent)
  return cdp
}

// ----------------------------------------------------------------- helpers ----

const ok = (v) => (v ? 'PASS' : 'FAIL')
const authHeaders = (token) => ({
  Authorization: 'Bearer ' + token,
  Accept: 'application/json',
  'Cache-Control': 'no-cache',
  'Accept-Encoding': 'identity',
})
async function apiJson(cfg, token, path) {
  const r = await fetch(cfg.base + path, { headers: authHeaders(token) })
  const text = await r.text()
  let body = null
  try { body = JSON.parse(text) } catch {}
  return { status: r.status, body, text }
}
async function assetOk(url) {
  try { const r = await fetch(url); return r.status === 200 } catch { return false }
}

// ------------------------------------------------------------------ layers ----

export async function runLayers(cdp, cfg, token) {
  const checks = []
  const add = (layer, id, status, detail) => checks.push({ layer, id, status, detail })
  mkdirSync(cfg.shotDir, { recursive: true })

  // ---------------- L0 前端资源完整性（公网 HTTP，只读） ----------------
  const indexResp = await fetch(cfg.base + '/')
  const indexHtml = await indexResp.text()
  const jsRefs = [...indexHtml.matchAll(/(?:src|href)="([^"]+\.js)"/g)].map((m) => m[1])
  const cssRefs = [...indexHtml.matchAll(/href="([^"]+\.css)"/g)].map((m) => m[1])
  const abs = (p) => (p.startsWith('http') ? p : cfg.base + (p.startsWith('/') ? '' : '/') + p)
  const entryJs = jsRefs[0] ? abs(jsRefs[0]) : ''
  let chunkUrls = []
  if (entryJs) {
    const jsText = await (await fetch(entryJs)).text()
    chunkUrls = [...new Set([...jsText.matchAll(/CanvasPage-[\w-]+\.js/g)].map((m) => m[0]))]
      .map((n) => cfg.base + '/assets/' + n)
  }
  add('L0', 'L0_1', ok(indexResp.status === 200 && indexHtml.includes('<div id="app">')), 'index 200 + SPA 壳')
  add('L0', 'L0_2', ok(entryJs && await assetOk(entryJs)), 'entry js ' + basename(entryJs || '-'))
  add('L0', 'L0_3', ok(cssRefs.length > 0 && await assetOk(abs(cssRefs[0]))), 'entry css ' + basename(cssRefs[0] || '-'))
  add('L0', 'L0_4', ok(chunkUrls.length > 0 && await assetOk(chunkUrls[0])), 'lazy chunk ' + basename(chunkUrls[0] || '-'))

  // ---------------- L1 只读后端契约（自签 Bearer） ----------------
  const health = await apiJson(cfg, token, '/api/health')
  const sessions = await apiJson(cfg, token, '/api/sessions')
  const threads = await apiJson(cfg, token, `/api/agent/chat/threads?sessionId=${cfg.sessionId}`)
  const messages = await apiJson(cfg, token, `/api/agent/chat/user/messages?sessionId=${cfg.sessionId}&threadId=${cfg.sessionId}`)
  const runtime = await apiJson(cfg, token, '/api/agent/runtime-health')
  const asList = (r) => (Array.isArray(r.body?.data) ? r.body.data : Array.isArray(r.body) ? r.body : null)
  add('L1', 'L1_1', ok(health.status === 200), '/api/health ' + health.status)
  add('L1', 'L1_2', ok(sessions.status === 200 && asList(sessions) !== null), '/api/sessions ' + sessions.status)
  add('L1', 'L1_3', ok(threads.status === 200), '/api/agent/chat/threads ' + threads.status)
  add('L1', 'L1_4', ok(messages.status === 200 && asList(messages) !== null), '/api/agent/chat/user/messages ' + messages.status + ' count=' + (asList(messages) || []).length)
  add('L1', 'L1_5', ok(runtime.status === 200), '/api/agent/runtime-health ' + runtime.status)

  // ---------------- L2 会话页 DOM / 侧栏可见性 ----------------
  const dom = JSON.parse(await cdp.evalJs(`JSON.stringify((() => {
    const app = document.getElementById('app');
    const bodyText = (document.body.innerText || '').trim();
    const count = (sel) => document.querySelectorAll(sel).length;
    return {
      href: location.href,
      appChildren: app ? app.children.length : -1,
      bodyTextLen: bodyText.length,
      tokenStored: !!localStorage.getItem('token'),
      hasLoginText: /登录|登陆|sign in|log in/i.test(bodyText.slice(0, 800)),
      hasErrorText: /出错了|加载失败|Something went wrong|Unexpected end of JSON|Unexpected token/i.test(bodyText),
      counts: {
        messageLike: count('[class*="message"],[class*="bubble"],[class*="turn"]'),
        canvasLike: count('[class*="canvas"],[class*="vue-flow"],canvas'),
        railLike: count('[class*="rail"],[class*="sidebar"],[class*="dock"]'),
      },
    };
  })())`))
  const pageErrors = cdp.events.filter((e) => e.method === 'Runtime.exceptionThrown')
    .map((e) => (e.params?.exceptionDetails?.text || '') + ' ' + (e.params?.exceptionDetails?.exception?.description || '').slice(0, 200))
  const consoleErrors = cdp.events.filter((e) => e.method === 'Runtime.consoleAPICalled' && e.params?.type === 'error')
    .map((e) => (e.params?.args || []).map((a) => a.value ?? a.description ?? '').join(' '))
  const logErrors = cdp.events.filter((e) => e.method === 'Log.entryAdded' && e.params?.entry?.level === 'error')
    .map((e) => String(e.params?.entry?.text || ''))
  const status304 = cdp.events.filter((e) => e.method === 'Network.responseReceived' && e.params?.response?.status === 304)
  const errorText = [...pageErrors, ...consoleErrors, ...logErrors].join(' ')
  add('L2', 'A1_spa_mounted', ok(dom.appChildren > 0), 'appChildren=' + dom.appChildren)
  add('L2', 'A2_not_blank', ok(dom.bodyTextLen > 200), 'bodyTextLen=' + dom.bodyTextLen)
  add('L2', 'A3_stayed_on_workflow', ok(dom.href.includes('/workflow/')), dom.href)
  add('L2', 'A4_no_pageerror', ok(pageErrors.length === 0), 'exceptionThrown=' + pageErrors.length)
  add('L2', 'A5_no_json_parse_error', ok(!/Unexpected end of JSON|Unexpected token|json\(\)/i.test(errorText)), 'json parse errors=0')
  add('L2', 'A6_no_304', ok(status304.length === 0), '304=' + status304.length)
  add('L2', 'A7_token_injected', ok(dom.tokenStored), 'localStorage.token present')
  add('L2', 'A8_no_login_redirect', ok(!dom.hasLoginText), 'no login text')
  add('L2', 'A9_has_content_elements', ok(dom.counts.messageLike + dom.counts.canvasLike + dom.counts.railLike > 0), JSON.stringify(dom.counts))
  add('L2', 'A10_no_error_banner', ok(!dom.hasErrorText), 'no error banner')

  const clicked = await cdp.evalJs(`(() => {
    const fab = document.querySelector('button.agent-fab');
    if (!fab) return 'ALREADY_OPEN';
    fab.click(); return 'CLICKED';
  })()`)
  await sleep(3000)
  const after = JSON.parse(await cdp.evalJs(`JSON.stringify((() => {
    const a = document.querySelector('aside.agent-side-rail');
    const s = document.querySelector('.agent-panel-shell');
    const visible = (sel) => [...document.querySelectorAll(sel)].filter((el) => {
      const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0;
    }).length;
    const rect = (el) => { const r = el.getBoundingClientRect(); return Math.round(r.width); };
    const inputs = [...document.querySelectorAll('textarea,input,[contenteditable]')]
      .filter((el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; }).length;
    const sendButtons = [...document.querySelectorAll('button')].filter((b) => {
      const r = b.getBoundingClientRect();
      return r.width > 0 && /发送|生成|send|generate|提交/i.test(
        (b.getAttribute('title') || '') + (b.getAttribute('aria-label') || '') + (b.innerText || '') + (b.getAttribute('class') || ''));
    }).length;
    return {
      asideWidth: a ? rect(a) : -1,
      asideClass: a ? a.getAttribute('class') : null,
      shellWidth: s ? rect(s) : -1,
      shellDisplay: s ? getComputedStyle(s).display : 'missing',
      fabStillPresent: !!document.querySelector('button.agent-fab'),
      visibleTurns: visible('.agent-turn'),
      visibleBubbles: visible('.agent-bubble'),
      visibleMsgActionBtns: visible('.agent-msg-action-btn'),
      visibleChatScroll: visible('.agent-chat-scroll'),
      inputs, sendButtons,
    };
  })())`))
  add('L2', 'B1_rail_expanded', ok(after.asideWidth > 100), 'asideWidth=' + after.asideWidth + ' fabAction=' + clicked)
  add('L2', 'B2_shell_visible', ok(after.shellDisplay !== 'none' && after.shellWidth > 100), after.shellDisplay + ' w=' + after.shellWidth)
  add('L2', 'B3_fab_consumed', ok(!after.fabStillPresent), 'fabStillPresent=' + after.fabStillPresent)
  add('L2', 'B4_turns_visible', ok(after.visibleTurns > 0), 'turns=' + after.visibleTurns)
  add('L2', 'B5_bubbles_visible', ok(after.visibleBubbles > 0), 'bubbles=' + after.visibleBubbles)
  add('L2', 'B6_msg_actions_visible', ok(after.visibleMsgActionBtns > 0), 'buttons=' + after.visibleMsgActionBtns)
  add('L2', 'B7_chat_scroll_visible', ok(after.visibleChatScroll > 0), 'scroll=' + after.visibleChatScroll)
  add('L2', 'B8_composer_found', ok(after.inputs > 0), 'inputs=' + after.inputs)
  add('L2', 'B9_send_button_found', ok(after.sendButtons > 0), 'sendButtons=' + after.sendButtons)

  // ---------------- L3 真实回合（默认 SKIPPED，绝不产生写操作） ----------------
  if (!cfg.write) {
    add('L3', 'L3_SKIPPED', 'SKIP', 'LNKPI_SMOKE_WRITE != 1，只读模式')
  } else {
    const before = asList(await apiJson(cfg, token, `/api/agent/chat/user/messages?sessionId=${cfg.sessionId}&threadId=${cfg.sessionId}`)) || []
    const beforeIds = new Set(before.map((x) => x.id))
    const baselineTurns = JSON.parse(await cdp.evalJs(`JSON.stringify((()=>({
      turns: document.querySelectorAll('.agent-turn').length,
      railWidth: Math.round((document.querySelector('aside.agent-side-rail')||{getBoundingClientRect:()=>({width:0})}).getBoundingClientRect().width),
    }))())`))
    await cdp.evalJs(`(() => {
      const ta = document.querySelector('textarea.mention-input-field');
      if (!ta) return 'NO_TEXTAREA';
      ta.focus();
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
      setter.call(ta, ${JSON.stringify(cfg.probeText)});
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      ta.dispatchEvent(new Event('change', { bubbles: true }));
      return 'TYPED';
    })()`)
    await sleep(900)
    await cdp.evalJs(`(() => {
      const b = [...document.querySelectorAll('.dock-generate-btn')].find((x) => {
        const r = x.getBoundingClientRect(); return r.width > 0 && r.height > 0;
      });
      if (!b) return 'NO_SEND_BUTTON';
      b.click(); return 'CLICKED';
    })()`)
    let finalNew = []
    const t0 = Date.now()
    while (Date.now() - t0 < cfg.pollLimitMs) {
      await sleep(3000)
      const cur = asList(await apiJson(cfg, token, `/api/agent/chat/user/messages?sessionId=${cfg.sessionId}&threadId=${cfg.sessionId}`)) || []
      finalNew = cur.filter((x) => !beforeIds.has(x.id))
      if (finalNew.some((x) => x.role === 'assistant' && String(x.content || '').trim().length > 0)) break
    }
    const reqMeta = new Map()
    for (const e of cdp.events) {
      const p = e.params || {}
      if (e.method === 'Network.requestWillBeSent') reqMeta.set(p.requestId, { url: p.request?.url || '', method: p.request?.method || '' })
      if (e.method === 'Network.responseReceived') {
        const prev = reqMeta.get(p.requestId) || {}
        reqMeta.set(p.requestId, { ...prev, status: p.response?.status, mime: p.response?.mimeType })
      }
    }
    const conv = [...reqMeta.entries()].filter(([, m]) => m.url.includes('/chat/conversation'))
    let ackBody = null, ackStatus = null, ackMime = null
    for (const [id, m] of conv) {
      ackStatus = m.status; ackMime = m.mime
      try {
        const rb = await cdp.send('Network.getResponseBody', { requestId: id })
        ackBody = rb.base64Encoded ? Buffer.from(rb.body, 'base64').toString('utf8') : rb.body
      } catch {}
    }
    let ackJson = null
    try { ackJson = JSON.parse(ackBody) } catch {}
    const sseReqs = [...reqMeta.entries()].filter(([, m]) => m.url.includes('/runs/events'))
    let sseDataTotal = 0
    for (const e of cdp.events) {
      if (e.method === 'Network.dataReceived' && sseReqs.some(([id]) => id === e.params?.requestId)) {
        sseDataTotal += e.params?.encodedDataLength || 0
      }
    }
    const errs = cdp.events.filter((e) => e.method === 'Runtime.exceptionThrown').length
    const consoleErrs = cdp.events.filter((e) => e.method === 'Runtime.consoleAPICalled' && e.params?.type === 'error').length
    const afterDom = JSON.parse(await cdp.evalJs(`JSON.stringify((()=>({
      turns: document.querySelectorAll('.agent-turn').length,
      railWidth: Math.round((document.querySelector('aside.agent-side-rail')||{getBoundingClientRect:()=>({width:0})}).getBoundingClientRect().width),
      composerValue: (document.querySelector('textarea.mention-input-field')||{}).value || '',
    }))())`))
    add('L3', 'C1_post_made', ok(conv.length > 0), 'conversation requests=' + conv.length)
    add('L3', 'C2_ack_2xx', ok(ackStatus >= 200 && ackStatus < 300), 'ack=' + ackStatus)
    add('L3', 'C3_json_not_sse', ok(/json/i.test(ackMime || '') && !/event-stream/i.test(ackMime || '')), 'mime=' + ackMime)
    add('L3', 'C4_accepted_true', ok((ackJson?.data?.accepted ?? ackJson?.accepted) === true), 'accepted')
    add('L3', 'C5_polled_terminal', ok(finalNew.length > 0), 'newMessages=' + finalNew.length)
    add('L3', 'C6_new_assistant_message', ok(finalNew.some((x) => x.role === 'assistant' && String(x.content || '').trim().length > 0)), 'assistant finalized')
    add('L3', 'C7_new_user_echo', ok(finalNew.some((x) => x.role === 'user' && /SMOKE-OK|冒烟探针/.test(String(x.content || '')))), 'user echo')
    add('L3', 'C8_owner_stream_data', ok(sseReqs.length > 0 && sseDataTotal > 0), 'sse=' + sseReqs.length + ' bytes=' + sseDataTotal)
    add('L3', 'C9_no_pageerror', ok(errs === 0), 'exceptionThrown=' + errs)
    add('L3', 'C10_no_console_error', ok(consoleErrs === 0), 'consoleErrors=' + consoleErrs)
    add('L3', 'C11_dom_turn_grew', ok(afterDom.turns > baselineTurns.turns), 'turns ' + baselineTurns.turns + '->' + afterDom.turns)
    add('L3', 'C12_rail_still_open', ok(afterDom.railWidth > 100), 'railWidth=' + afterDom.railWidth)
    add('L3', 'C13_composer_cleared', ok(afterDom.composerValue.length === 0), 'composerLen=' + afterDom.composerValue.length)
  }

  // ---------------- L4 画布 / 分享 ----------------
  const canvas = JSON.parse(await cdp.evalJs(`JSON.stringify((() => {
    const visible = (sel) => [...document.querySelectorAll(sel)].filter((el) => {
      const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0;
    }).length;
    return { nodes: visible('.vue-flow__node'), edges: visible('.vue-flow__edge') };
  })())`))
  add('L4', 'L4_1', ok(canvas.nodes > 0), 'vue-flow nodes=' + canvas.nodes)
  add('L4', 'L4_2', ok(canvas.edges > 0), 'vue-flow edges=' + canvas.edges)
  let shareStatus = 'SKIP'
  let shareDetail = 'LNKPI_SHARE_ID 未提供，分享静态页判据跳过且不计 PASS'
  if (cfg.shareId) {
    let shareOk = false
    try {
      const localPort = new URL(cfg.base).port || '80'
      const shareUrl = `http://127.0.0.1:${localPort}/share/${cfg.shareId}.html`
      const out = execFileSync('ssh', ['-o', 'BatchMode=yes', cfg.sshHost,
        `curl -s -o /dev/null -w '%{http_code}' ${shareUrl}`], { encoding: 'utf8' }).trim()
      const body = execFileSync('ssh', ['-o', 'BatchMode=yes', cfg.sshHost,
        `curl -s ${shareUrl}`], { encoding: 'utf8' })
      shareOk = out === '200' && /<!doctype html/i.test(body) && /<style/i.test(body)
    } catch {}
    shareStatus = ok(shareOk)
    shareDetail = 'share/' + cfg.shareId + '.html status=' + shareStatus
  }
  add('L4', 'L4_3', shareStatus, shareDetail)

  try {
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' })
    writeFileSync(join(cfg.shotDir, 'prod-cdp-smoke.png'), Buffer.from(shot.data, 'base64'))
  } catch {}
  return checks
}

// --------------------------------------------------------------- summarize ----

export function summarize(checks) {
  const pass = checks.filter((c) => c.status === 'PASS').length
  const fail = checks.filter((c) => c.status === 'FAIL').length
  const skip = checks.filter((c) => c.status === 'SKIP').length
  for (const c of checks) {
    console.log(`  ${c.status.padEnd(4)}  ${c.id.padEnd(26)} ${c.detail}`)
  }
  console.log(`VERDICT pass=${pass} fail=${fail} skip=${skip} total=${checks.length}`)
  return { pass, fail, skip, exitCode: fail > 0 ? 1 : 0 }
}

// -------------------------------------------------------------------- main ----

async function main() {
  const cfg = readConfig(process.env)
  const token = mintJwt(cfg)
  const cdp = await runPreflight(cfg, token)
  const checks = await runLayers(cdp, cfg, token)
  const result = summarize(checks)
  cdp.close()
  process.exit(result.exitCode)
}

if (import.meta.url === 'file://' + process.argv[1] || process.argv[1]?.endsWith('prod-cdp-smoke.mjs')) {
  main().catch((e) => { console.error('FATAL ' + e.message); process.exit(1) })
}
