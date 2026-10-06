// StepFun TTS 真实生成验收探针（充值后跑）。
//
// 用途：确认「充值后真的能出音频」——不验这个，PR #227 的改动只是「理论上能接」。
//
// 三件事：
//  1. 直打 StepFun POST /v1/audio/speech：短文本 → 判据是**响应体魔数**（真音频），不是「没报错」；
//     落地成文件供人耳复核（音色是否中文自然、有无「instruction 被念出来」）。
//  2. 1200 字长文本**单发**，预期 400 —— 用来证明上游 1000 字符硬限真实存在（不是文档传说）。
//  3. 再用**仓库里真实的分片实现**跑同一段文本，预期 PASS —— 与第 2 步对照才构成证据闭环。
//
// 用法：
//   容器内（密钥不出容器）：docker exec -i lnkpi-api node - < stepfun-tts-live-probe.mjs
//   本机：STEPFUN_API_KEY=... node deploy/stepfun-tts-live-probe.mjs
// 可选：STEPFUN_BASE_URL / STEPFUN_MODEL / STEPFUN_VOICE
//
// 判据：短句 PASS + 分片 PASS + 人耳复核通过。**任何非 2xx 都不算通过。**

import { existsSync, writeFileSync } from 'node:fs'

const KEY = process.env.STEPFUN_API_KEY || ''
const BASE = (process.env.STEPFUN_BASE_URL || 'https://api.stepfun.com/v1').replace(/\/+$/, '')
const MODEL = process.env.STEPFUN_MODEL || 'stepaudio-3-tts'
const VOICE = process.env.STEPFUN_VOICE || 'cixingnansheng'

function magic(b) {
  if (!b || !b.length) return 'EMPTY'
  if (b[0] === 0x49 && b[1] === 0x44 && b[2] === 0x33) return 'MP3(ID3)'
  if (b[0] === 0xff && (b[1] & 0xf0) === 0xf0) return 'MP3(frame)'
  if (b.slice(0, 4).toString() === 'OggS') return 'OGG'
  if (b.slice(0, 4).toString() === 'RIFF') return 'WAV'
  if (b[0] === 0x1a && b[1] === 0x45) return 'WEBM'
  return 'TEXT(' + b.slice(0, 80).toString('utf8').replace(/\s+/g, ' ') + ')'
}

async function once(label, input, extra = {}) {
  const t0 = Date.now()
  const res = await fetch(BASE + '/audio/speech', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + KEY },
    body: JSON.stringify({ model: MODEL, input, voice: VOICE, ...extra }),
  })
  const ms = Date.now() - t0
  const ct = res.headers.get('content-type') || ''
  if (!res.ok) {
    const txt = await res.text()
    console.log(`FAIL ${label} -> ${res.status} ${ct} ${ms}ms :: ${txt.slice(0, 200)}`)
    return { ok: false, status: res.status }
  }
  const buf = Buffer.from(await res.arrayBuffer())
  const m = magic(buf)
  const ok = !m.startsWith('TEXT(') && m !== 'EMPTY'
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label} -> ${res.status} ${ct} bytes=${buf.length} ${m} ${ms}ms`)
  return { ok, bytes: buf.length, magic: m, buf }
}

// dist 不在 git 里，路径按实际部署形态探测（不猜一个不存在的路径）
const CANDIDATES = [
  '/app/apps/server/dist/../node_modules/@lnkpi/agent/dist/tools/audio-provider.js',
  '/app/apps/server/node_modules/@lnkpi/agent/dist/tools/audio-provider.js',
  '/app/node_modules/@lnkpi/agent/dist/tools/audio-provider.js',
]

async function loadSplitter() {
  for (const p of CANDIDATES) {
    if (existsSync(p)) {
      const m = await import(p)
      if (typeof m.splitTextForTts === 'function') {
        console.log(`     分片实现：${p}`)
        return m.splitTextForTts
      }
    }
  }
  return null
}

async function main() {
  if (!KEY) {
    console.log('SKIP 未设 STEPFUN_API_KEY')
    return
  }
  console.log(`base=${BASE} model=${MODEL} voice=${VOICE}\n`)

  const short = await once('短句（音色 + instruction）', '秋日上新，欢迎光临。', {
    instruction: '语气明快欢快，节奏轻快',
  })
  if (short.ok && short.buf) {
    const p = `/tmp/stepfun-tts-${Date.now()}.mp3`
    writeFileSync(p, short.buf)
    console.log(`     已落地：${p}`)
    console.log('     人耳复核点：中文是否自然；有没有把 instruction 的字面念出来')
  }

  const long = '这是一句用于验证分片的中文台词。'.repeat(50)
  console.log(`\n长文本 ${long.length} 字符（上游单次硬限 1000）`)

  const naive = await once('长文本·单发（预期 400，用于证明限制真实存在）', long)
  if (naive.ok) console.log('     ⚠️ 上游接受了 >1000 字符 ⇒ 分片可省，先复核官方文档是否已变更')

  let chunked = '未验'
  const splitTextForTts = await loadSplitter()
  if (!splitTextForTts) {
    console.log('     未找到镜像内的分片实现，跳过对照（不影响第 1 项结论）')
  } else {
    const chunks = splitTextForTts(long, 1000)
    console.log(`     分片数=${chunks.length} 各片长度=${chunks.join(',')}`)
    const merged = []
    for (const c of chunks) {
      const r = await once('长文本·分片', c, { instruction: '语气明快欢快' })
      if (!r.ok) break
      merged.push(r.buf)
    }
    if (merged.length === chunks.length) {
      chunked = 'PASS'
      console.log(`     分片全部成功，合并字节=${Buffer.concat(merged).length}`)
    }
  }

  console.log(`\n=== 结论：短句 ${short.ok ? 'PASS' : 'FAIL'} / 分片 ${chunked} ===`)
  console.log('验收标准：短句 PASS + 分片 PASS + 人耳复核通过；缺一不算验收完成。')
}

main().catch((e) => {
  console.error('FATAL', e)
  process.exitCode = 1
})
