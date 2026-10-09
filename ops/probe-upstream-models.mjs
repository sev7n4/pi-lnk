#!/usr/bin/env node
/**
 * S0-3 部署后冒烟探针：模型目录 ↔ 各上游 /v1/models 实测清单对账（只读）。
 *
 * ⚠️ 探活只读 /v1/models，任何情况下不发送真实生成请求。
 * ⚠️ 密钥只从 process.env 读取；本脚本不落盘、不打印任何密钥。
 *
 * 用法（完整说明见 docs/ops/2026-10-09-upstream-probe-runbook.md）：
 *   本地直跑：
 *     node --experimental-strip-types ops/probe-upstream-models.mjs
 *   CVM 容器内（脚本经 stdin 灌入，不落盘到镜像——scripts/ 永远不进 api 镜像）：
 *     ssh <cvm> "docker exec -i lnkpi-api node --experimental-strip-types -" \
 *       < ops/probe-upstream-models.mjs
 *
 * 退出码：有 ghost 或任一上游 402/403 → 1；否则 0（不可用/跳过不判败）。
 * 依赖：Node ≥ 22.6（--experimental-strip-types），零三方依赖（undici 仅在
 * 设置了 HTTPS_PROXY 时可选动态加载，失败则跳过代理并在报告标注）。
 */

import { registerHooks } from 'node:module'
import { pathToFileURL } from 'node:url'
import path from 'node:path'

/**
 * ESM 解析兜底：shared 源码内部是 TypeScript 风格的无扩展名相对导入
 * （如 studioModelCatalog.ts → './providerChannels'），Node 严格 ESM 不补
 * 扩展名；此处对失败的无扩展名相对 specifier 追加 `.ts` 重试。
 * 仅影响本进程，对已带扩展名/裸 specifier 无副作用。
 */
registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context)
    } catch (err) {
      if (specifier.startsWith('.') && !/\.[cm]?[jt]s$/.test(specifier)) {
        return nextResolve(`${specifier}.ts`, context)
      }
      throw err
    }
  },
})

const USAGE = `用法：node --experimental-strip-types ops/probe-upstream-models.mjs

对 5 个上游网关做只读探活（GET /v1/models），与模型目录 diff 输出 Markdown 对账报告。

上游环境变量（密钥只从环境读取，缺失该上游记 unavailable）：
  OPENAI_BASE_URL / OPENAI_API_KEY      agnes hub（无默认 base url）
  APIMART_BASE_URL / APIMART_API_KEY    apimart（默认 https://api.apimart.ai/v1）
  FAL_BASE_URL / FAL_KEY                fal（默认 https://fal.run）
  MINIMAX_BASE_URL / MINIMAX_API_KEY    MiniMax（默认 https://api.minimax.io）
  STEPFUN_BASE_URL / STEPFUN_API_KEY    StepFun（默认 https://api.stepfun.com/v1）

可选：HTTPS_PROXY（apimart 跨境需代理；需 undici 可加载，否则跳过并标注）
      PROBE_TIMEOUT_MS（单上游请求超时，默认 15000）

退出码：有 ghost 或任一上游 402/403 → 1；否则 0。
⚠️ 本探针只读 /v1/models，禁止发送任何真实生成请求。`

/**
 * family→upstream 路由表。与 platformCredentials.ts 保持一致，S2-2 路由表落地后改为 import。
 * 两层来源：
 * - platformCredentials resolver 族：/^step/i（stepfun）、/^minimax-h3$/i（minimax）、
 *   /h3-max/i（fal）、apimart-backed 图片名单（seedream / gpt-image-2 / image2）；
 * - 总体规格 §2.2 运行时路由表补全其余家族：agnes 系 → agnes hub、非 agnes 系
 *   图片/视频（seedance/wan/midjourney/navo/happyhose 等）→ apimart、MiniMax 语音
 *   家族 → minimax、音频层（seed-audio）→ stepfun。
 * 兜底 = agnes hub 文本通道（gemini-/deepseek-/gpt- 等 LLM 家族）。
 */
const ROUTING_MAP = [
  { upstream: 'stepfun', pattern: /^step|^seed-audio/i },
  { upstream: 'minimax', pattern: /^minimax-h3$|^minimax-speech/i },
  { upstream: 'fal', pattern: /h3-max/i },
  {
    upstream: 'apimart',
    pattern:
      /^seedance-|^doubao-seedance-|^wan-|^seedream-|^doubao-seedream-|^gpt-image-2|^image2$|^midjourney-|^navo-|^happyhose-/i,
  },
  { upstream: 'agnes', pattern: /^agnes-/i },
]

const UPSTREAMS = [
  { id: 'agnes', label: 'agnes hub', baseUrlEnv: 'OPENAI_BASE_URL', keyEnv: 'OPENAI_API_KEY', defaultBaseUrl: '' },
  { id: 'apimart', label: 'apimart', baseUrlEnv: 'APIMART_BASE_URL', keyEnv: 'APIMART_API_KEY', defaultBaseUrl: 'https://api.apimart.ai/v1' },
  { id: 'fal', label: 'fal', baseUrlEnv: 'FAL_BASE_URL', keyEnv: 'FAL_KEY', defaultBaseUrl: 'https://fal.run' },
  { id: 'minimax', label: 'MiniMax', baseUrlEnv: 'MINIMAX_BASE_URL', keyEnv: 'MINIMAX_API_KEY', defaultBaseUrl: 'https://api.minimax.io' },
  { id: 'stepfun', label: 'StepFun', baseUrlEnv: 'STEPFUN_BASE_URL', keyEnv: 'STEPFUN_API_KEY', defaultBaseUrl: 'https://api.stepfun.com/v1' },
]

const TIMEOUT_MS = Number(process.env.PROBE_TIMEOUT_MS ?? 15000)

/**
 * shared 模块解析。候选顺序：
 * 1. 脚本相对路径 → packages/shared/src/*.ts（本地直跑；需 --experimental-strip-types）；
 * 2. cwd 相对路径 → 同上（stdin 形态且 cwd=仓库根时）；
 * 3. 容器镜像路径 /app/packages/shared/dist/*.js（docker exec 形态：镜像构建时已把
 *    shared 编译为 dist，且镜像内 src 被清除——见 deploy/docker/Dockerfile.api）。
 * 禁止在任何位置重写第二套 diff 逻辑（总体规格 §3.3 门禁）。
 */
function sharedCandidates(fileName) {
  const candidates = []
  if (typeof import.meta.url === 'string' && import.meta.url.startsWith('file:') && import.meta.url.endsWith('.mjs')) {
    candidates.push(new URL(`../packages/shared/src/${fileName}`, import.meta.url).href)
  }
  candidates.push(pathToFileURL(path.resolve(process.cwd(), 'packages/shared/src', fileName)).href)
  candidates.push(`file:///app/packages/shared/dist/${fileName.replace(/\.ts$/, '.js')}`)
  return candidates
}

async function importShared(fileName) {
  const errors = []
  for (const url of sharedCandidates(fileName)) {
    try {
      return await import(url)
    } catch (err) {
      errors.push(`${url}: ${err?.message ?? err}`)
    }
  }
  throw new Error(
    `无法加载 shared 模块 ${fileName}。已尝试：\n  ${errors.join('\n  ')}\n` +
      '本地直跑请在仓库根目录执行并加 --experimental-strip-types；容器形态需使用含本功能的镜像。',
  )
}

/** baseUrl 拼接 /models：base 已含 /v1 后缀则直接接，否则补 /v1。 */
function modelsUrl(baseUrl) {
  const trimmed = baseUrl.trim().replace(/\/+$/, '')
  return trimmed.endsWith('/v1') ? `${trimmed}/models` : `${trimmed}/v1/models`
}

async function proxyDispatcher() {
  const proxy = process.env.HTTPS_PROXY ?? process.env.https_proxy
  if (!proxy) return { dispatcher: undefined, note: undefined }
  try {
    const undici = await import('undici')
    return { dispatcher: new undici.ProxyAgent(proxy), note: undefined }
  } catch {
    return { dispatcher: undefined, note: `已设置 HTTPS_PROXY 但 undici 不可加载，未走代理` }
  }
}

/**
 * 单上游只读探活。绝不抛出——失败一律折叠为 unavailable(reason)；
 * 无 /models 端点（404）→ NO_MODELS_ENDPOINT（正常跳过，不视为失败）。
 */
async function fetchModelIds(upstream, dispatcher) {
  const baseUrl = process.env[upstream.baseUrlEnv]?.trim() || upstream.defaultBaseUrl
  if (!baseUrl) {
    return { status: 'unavailable', reason: `未配置 ${upstream.baseUrlEnv}` }
  }
  const apiKey = process.env[upstream.keyEnv]?.trim()
  if (!apiKey) {
    return { status: 'unavailable', reason: `未配置 ${upstream.keyEnv}` }
  }

  let res
  try {
    res = await fetch(modelsUrl(baseUrl), {
      method: 'GET',
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(TIMEOUT_MS),
      ...(dispatcher ? { dispatcher } : {}),
    })
  } catch (err) {
    const cause = err?.cause?.code ?? err?.name ?? ''
    const reason = cause === 'TimeoutError' || err?.name === 'TimeoutError' ? `超时（>${TIMEOUT_MS}ms）` : `网络错误（${cause || '未知'}）`
    return { status: 'unavailable', reason }
  }

  if (res.status === 404) {
    return { status: 'NO_MODELS_ENDPOINT' }
  }
  // 402=欠费 / 403=鉴权失败：上游断供信号，计入失败退出码（runbook 报告解读表）
  if (res.status === 402 || res.status === 403) {
    return { status: 'unavailable', reason: `HTTP ${res.status}（${res.status === 402 ? '余额不足' : '鉴权失败'}）`, fatal: true }
  }
  if (!res.ok) {
    return { status: 'unavailable', reason: `HTTP ${res.status}` }
  }

  let body
  try {
    body = await res.json()
  } catch {
    return { status: 'unavailable', reason: '响应不是合法 JSON' }
  }
  const data = body?.data
  if (!Array.isArray(data)) {
    return { status: 'unavailable', reason: '响应缺少 data 数组（非 OpenAI /models 形状），保守不猜结构' }
  }
  const ids = data.map((m) => m?.id).filter((id) => typeof id === 'string' && id.trim() !== '')
  return { status: 'ok', ids }
}

function section(title, items) {
  if (items.length === 0) return '无'
  return `\n${items.map((id) => `- \`${id}\``).join('\n')}`
}

function renderReport({ catalogSize, results, proxyNote }) {
  const lines = []
  lines.push('# 上游模型对账报告（S0-3 冒烟探针）')
  lines.push('')
  lines.push(`- 运行时间：${new Date().toISOString()}`)
  lines.push(`- 目录：\`packages/shared/src/studioModelCatalog.ts\`（${catalogSize} 条）`)
  lines.push(`- 探活方式：只读 GET /v1/models（**未发送任何真实生成请求**）`)
  if (proxyNote) lines.push(`- 代理：${proxyNote}`)
  lines.push('')

  for (const { upstream, probe } of results) {
    lines.push(`## ${upstream.label}（${upstream.id}）`)
    lines.push('')
    if (probe.status === 'ok') {
      lines.push(`- 状态：✅ ok（/v1/models 返回 ${probe.ids.length} 个）`)
      lines.push(`- 幽灵（目录有、上游无 → 用户可选必挂，须下架）：${section('ghosts', probe.diff.ghosts)}`)
      lines.push(`- 缺失（上游有、目录无 → 上架机会）：${section('missing', probe.diff.missing)}`)
      lines.push(`- 匹配：${probe.diff.matched.length} 个`)
    } else if (probe.status === 'NO_MODELS_ENDPOINT') {
      lines.push(`- 状态：⏭️ NO_MODELS_ENDPOINT（该上游无 /models 端点，按约定跳过，不视为失败）`)
    } else {
      const fatalMark = probe.fatal ? ' **（402/403：计入失败退出码，需充值/换 key）**' : ''
      lines.push(`- 状态：⛔ unavailable — ${probe.reason}${fatalMark}`)
      lines.push(`- 幽灵：无（上游不可达 ≠ 模型幽灵，绝不误报）`)
    }
    lines.push('')
  }

  lines.push('## 汇总')
  lines.push('')
  lines.push('| 上游 | 状态 | 模型数 | ghost | 缺失 |')
  lines.push('|---|---|---|---|---|')
  for (const { upstream, probe } of results) {
    const status =
      probe.status === 'ok' ? 'ok' : probe.status === 'NO_MODELS_ENDPOINT' ? 'NO_MODELS_ENDPOINT' : `unavailable(${probe.reason})`
    const ghostCount = probe.status === 'ok' ? probe.diff.ghosts.length : 0
    const missingCount = probe.status === 'ok' ? probe.diff.missing.length : 0
    lines.push(`| ${upstream.label} | ${status} | ${probe.status === 'ok' ? probe.ids.length : '-'} | ${ghostCount} | ${missingCount} |`)
  }
  lines.push('')
  return lines.join('\n')
}

async function main() {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    console.log(USAGE)
    process.exit(0)
  }

  const [{ diffCatalogAgainstUpstream }, catalogMod] = await Promise.all([
    importShared('upstreamReconciliation.ts'),
    importShared('studioModelCatalog.ts'),
  ])
  const catalog = catalogMod.STUDIO_MODEL_CATALOG ?? catalogMod.default?.STUDIO_MODEL_CATALOG
  if (!Array.isArray(catalog)) {
    throw new Error('shared 目录模块加载成功但不含 STUDIO_MODEL_CATALOG')
  }
  // 只传路由与 id 所需字段：diff 是纯集合运算，与目录其余字段无关
  const entries = catalog.map(({ modelKey, gatewayModelId }) => ({ modelKey, gatewayModelId }))

  const { dispatcher, note: proxyNote } = await proxyDispatcher()

  const results = []
  for (const upstream of UPSTREAMS) {
    const probe = await fetchModelIds(upstream, dispatcher)
    if (probe.status === 'ok') {
      probe.diff = diffCatalogAgainstUpstream(entries, probe.ids, ROUTING_MAP, { targetUpstream: upstream.id })
    }
    results.push({ upstream, probe })
  }

  const report = renderReport({ catalogSize: catalog.length, results, proxyNote })
  console.log(report)

  const hasGhost = results.some((r) => r.probe.status === 'ok' && r.probe.diff.ghosts.length > 0)
  const hasFatalUnavailable = results.some((r) => r.probe.fatal === true)
  process.exit(hasGhost || hasFatalUnavailable ? 1 : 0)
}

main().catch((err) => {
  console.error(`探针异常退出：${err?.message ?? err}`)
  process.exit(1)
})
