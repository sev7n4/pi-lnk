# 视频编辑时间线工具 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在画布上把已有 image/video/audio 节点编译成时间线草稿，显式确认后由服务端 Editly worker 渲染成独立成片视频节点。

**Architecture:** 数据只放 `video` 节点的 `data.timeline`，不新增 NodeType、不改 Prisma schema。服务端把时间线编译成 Editly spec，素材按 `node_id` 经 `MediaService` 归属校验后暂存，渲染结果落 uploads 并回写成片节点。pi-runtime 三个工具常驻，render 走 `pending_confirm + proposalKind` 确认事实。

**Tech Stack:** Vue 3 + TypeScript + NestJS + Prisma + pi-runtime TypeBox 工具 + `editly@0.14.2` + FFmpeg（api 镜像已安装）。

**Spec:** `docs/superpowers/specs/2026-11-25-video-timeline-editor-design.md`

## Global Constraints

- 渲染内核固定 `editly@0.14.2`（MIT）；禁止升级到 latest，禁止 `--enable-nonfree` FFmpeg。
- 不新增 `NodeType`；草稿/成片都是现有 `video` 节点，草稿以 `data.timeline` 区分。
- 不改 `apps/server/prisma/schema.prisma`；渲染任务用 `GenerationRecord.type='video_timeline_render'`，冻结 spec 放 `metadata` JSON。
- 所有画布写必须经 `transactGovernedCanvasOps(..., { onStaged: 'conflict' })`；新写者必须在 `canvas-write-governance.test.ts` 白名单逐条登记。
- 素材只接受画布 `node_id`；服务端从节点 data 取 url 并过 `MediaService.resolveDownloadSource()`；拒绝模型自带 URL / 跨账号节点。
- 三工具 `video_timeline_create/edit/render` 全部进 `ALWAYS_ON_TOOL_NAMES`，skill 正文按名点名；render 加入 `GATED_TOOLS`，但 gate 按 `proposalKind='video_timeline_render'` 放行。
- `VIDEO_TIMELINE_RENDER_ENABLED` 默认 false；2026-11-25 CVM 实测可用内存 487Mi、swap 已用 2.8Gi，扩容前生产保持 false，UI 导出按钮禁用并说明原因。
- 首期只允许 720p/1080p MP4；MOV / 2K / 4K 在 spike 未给出通过证据前从 UI 与服务端 allowlist 中移除。
- 前端样式只用 `apps/web/src/styles/design-tokens.css` 的 L2/L3 令牌，禁止新增 hex / rgba / `--neo-*`。
- 本地测试：node24 + vitest `--maxWorkers=1 --no-file-parallelism`；`vue-tsc -b` 不加 `--noEmit`；worktree 中先建真实 `node_modules` 或软链后再跑。
- PR 推送以 `gh api` 权威树为准；本地 `git push` 不可用。push 前 `git status --short` 必须为空。

## Review Focus

| 输入 / 条件 | 期望行为 | 归属任务与测试 |
|---|---|---|
| 同一 audioTrackIndex 两段区间 `[0,3)` 与 `[2,5)` | 整批拒绝、画布零写入、返回带 opIndex 的错误 | Task 3 `video-timeline.service.test.ts` |
| 模型传 `source_node_ids` 指向他人节点或自报 URL | 403 / 400，不下载、不渲染 | Task 3 权限测试 |
| `video_timeline_edit(save=true)` | 只写 `data.timeline`，无 `url`、无 GenerationRecord | Task 3 保存不渲染测试 |
| render 在 `draft` 态或 `proposalKind` 缺失时被调用 | generation-gate 拒绝；服务端再校验一次，双保险 | Task 4 gate 测试 |
| 默认导出音频长于画面 | 输出时长 == 画面时长；`keepFullAudioTail=true` 时 >= 画面时长 | Task 1 spike + Task 2 golden |
| 渲染期间用户修改草稿 | 已排队任务用冻结 spec，不受影响 | Task 3 快照测试 |

## 第一原则：吃满上游、不重复造轮子

**声明**：任何新增判据 / 工具 / 数据字段 / 引擎，立项前必须过三判据——① 等价物检索；② 接线优先于新建，判据锚到既有结构化数据面；③ 禁造数 / 禁自报。

### 开源等价物检索结论表

| 候选 | 一手事实 | 结论 | 接线方式 |
|---|---|---|---|
| `mifi/editly@0.14.2` | MIT；声明式 spec 含 `clips[].duration`、`video.cutFrom/cutTo`、`audioTracks[].start/cutFrom/cutTo/mixVolume`、`width/height/fps/outPath` | 采用 | 只写 `timeline → Editly spec` 纯函数 |
| FFmpeg | api 镜像 runner 已 `apt-get install ffmpeg`；默认 LGPL | 采用 | 只作 CLI，固定版本；禁止 nonfree |
| Remotion | 非 OSI 许可，大公司需付费 | 不采用 | — |
| OpenCut | MIT 但正在重写，classic 归档 | 仅 UI 参考 | 不引入依赖 |
| FFCreator / MLT | 停更或许可/部署过重 | 不采用 | — |

### 本项目等价物检索结论表

| 等价物 | 真实路径 / 符号 | 结论 | 接线方式 |
|---|---|---|---|
| 时间线数据模型 | `apps/web/src/utils/compositionUpstream.ts` | 复用并扩展 | canonical 类型下沉 shared，web 层 re-export |
| 画布写 | `apps/server/src/sessions/canvas-op-write.ts` | 唯一合法通道 | 三处写都走它 |
| 素材归属 | `apps/server/src/media/media.service.ts` | 复用 | 只传 nodeId，不传 URL |
| 任务状态 | `GenerationRecord` + `get_generation_status` | 复用 | 不建新表、不建新状态机 |
| 产物落库 | `PersistRemoteService` + uploads 目录 | 复用 | 渲染产物写 `/api/uploads/<userId>/<uuid>.mp4` 后 persist |
| 工具注册 | `registry.ts` / `config.ts` / `tiering.ts` | 复用 | 三工具常驻 + presentation 登记 |
| 卡片 | `CanvasNodeVideo.vue` | 复用 | `data.timeline` 分支渲染新子组件 |

---

## Task 1: Editly spike 与依赖锁定

**Files:**
- Create: `deploy/video-timeline/spike.mjs`
- Modify: `apps/server/package.json`
- Generate: `pnpm-lock.yaml`
- Create: `deploy/video-timeline/SPIKE_RESULT.md`

**Interfaces:**
- Consumes: 无。
- Produces: `EDITLY_ALLOWED_FORMATS`（首期实际值写入 spike 结果文档）、`apps/server` 的 `editly: 0.14.2` 依赖。

- [x] **Step 1: 写 spike 脚本**

`deploy/video-timeline/spike.mjs` 内容：

```js
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import editly from 'editly'

const dir = mkdtempSync(join(tmpdir(), 'editly-spike-'))
const run = (cmd, args) => execFileSync(cmd, args, { stdio: 'inherit' })
const out = join(dir, 'out.mp4')

run('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'color=c=red:s=320x180:d=2:r=25', '-c:v', 'libx264', join(dir, 'a.mp4')])
run('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'color=c=blue:s=320x180:d=2:r=25', '-c:v', 'libx264', join(dir, 'b.mp4')])
run('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'color=c=green:s=320x180:d=2:r=25', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', join(dir, 'still.mp4')])
run('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=8', join(dir, 'bgm.wav')])
run('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'sine=frequency=880:duration=8', join(dir, 'vo.wav')])

await editly({
  outPath: out,
  width: 1280,
  height: 720,
  fps: 25,
  keepSourceAudio: false,
  clips: [
    { duration: 2, layers: [{ type: 'video', path: join(dir, 'a.mp4'), cutFrom: 0, cutTo: 2, mixVolume: 0 }] },
    { duration: 3, layers: [{ type: 'image', path: join(dir, 'still.mp4') }] },
    { duration: 2, layers: [{ type: 'video', path: join(dir, 'b.mp4'), cutFrom: 0, cutTo: 2, mixVolume: 0 }] },
  ],
  audioTracks: [
    { path: join(dir, 'bgm.wav'), start: 0, cutFrom: 0, cutTo: 7, mixVolume: 0.5 },
    { path: join(dir, 'vo.wav'), start: 2, cutFrom: 0, cutTo: 2, mixVolume: 1 },
  ],
})

const probe = JSON.parse(execFileSync('ffprobe', [
  '-v', 'error', '-show_entries', 'format=duration:stream=width,height,codec_name',
  '-of', 'json', out,
], { encoding: 'utf8' }))
console.log(JSON.stringify({ ok: true, probe }, null, 2))
const duration = Number(probe.format?.duration ?? 0)
if (Math.abs(duration - 7) > 0.5) {
  console.error(`FAIL: expected visual-bounded duration 7s, got ${duration}s`)
  process.exitCode = 1
}
rmSync(dir, { recursive: true, force: true })
```

- [x] **Step 2: 在 Docker 里跑 spike**

预制镜像 `editly-spike:local`（node:22-bookworm + ffmpeg/xvfb + canvas/gl 原生工具链 + `npm install editly@0.14.2`，与 Task 6 的 api 镜像隔离方案同构）：

```bash
# ⚠️ 必须文件级挂载：镜像把 editly 装在 /work/node_modules，
# 若把宿主目录整体挂到 /work 会遮蔽 node_modules ⇒ ERR_MODULE_NOT_FOUND（卡死假象）。
docker run --rm -v "$PWD/deploy/video-timeline/spike.mjs":/work/spike.mjs:ro -w /work editly-spike:local \
  bash -lc 'xvfb-run -a node spike.mjs'
```

Expected: 打印 `ok:true`，`format.duration` 在 6.5~7.5 秒，宽高 1280×720。若原生依赖构建失败，记录完整错误并停止本计划，改用纯 FFmpeg 回退路径（需重新拍板）。

- [x] **Step 3: 锁定依赖（方案已改：镜像内 npm 隔离安装）**

⚠️ 2026-11-25 实施期纠正：原计划的「加进 `apps/server/package.json` + pnpm lock」会与 jsdom 的 `canvas@^3` 产生 peer 冲突、重污染整个 pnpm 解析图（jsdom peer 被降级），且 CI 无 cairo 头文件会红。
**实际方案**：`editly@0.14.2` 不进 pnpm workspace；`deploy/docker/Dockerfile.api` 的 build 阶段在 `/opt/editly` 用 `npm install` 隔离安装（含 canvas/gl 原生工具链），runner 阶段 `COPY --from=build /opt/editly` 并设 `ENV NODE_PATH=/opt/editly/node_modules`。运行时 CJS `require('editly')` 经 NODE_PATH 解析（已验证 TS `module: CommonJS` 下动态 `import()` 降级为 `Promise.resolve().then(() => require('editly'))`）。构建期 `test -d` 硬校验，不留静默坏镜像。`package.json` / lockfile 不改动。

- [x] **Step 4: 记录取证**

把 spike 输出、FFmpeg 版本（`ffmpeg -version | head -1`）、许可证判断写入 `deploy/video-timeline/SPIKE_RESULT.md`。明确写「首期允许格式 = mp4；MOV 未验证不得开放」或「MOV 已通过，参数 = ...」。

- [x] **Step 5: Commit**

```bash
git add apps/server/package.json pnpm-lock.yaml deploy/video-timeline
git commit -m "feat(video-timeline): spike editly renderer and pin dependency"
```

---

## Task 2: shared 时间线类型、校验与 Editly spec 编译器

**Files:**
- Create: `packages/shared/src/canvas/videoTimeline.ts`
- Create: `packages/shared/src/canvas/videoTimeline.test.ts`
- Modify: `packages/shared/src/index.ts`

**Interfaces:**
- Consumes: 无。
- Produces: `VideoTimeline`, `TimelineTrack`, `TimelineExport`, `TimelineOp`, `validateTimeline`, `compileTimelineToEditly`, `visualDurationSec`, `sanitizeTimelineFileName`。Task 3/4/5 全部依赖这些符号。

- [x] **Step 1: 写失败测试**

`packages/shared/src/canvas/videoTimeline.test.ts`：

```ts
import { describe, expect, it } from 'vitest'
import {
  compileTimelineToEditly,
  sanitizeTimelineFileName,
  validateTimeline,
  visualDurationSec,
  type VideoTimeline,
} from './videoTimeline'

const base = (): VideoTimeline => ({
  version: 1,
  clipCount: 2,
  trackOrder: ['v1', 'i1'],
  tracks: [
    { nodeId: 'v1', type: 'video', title: '镜头1', url: '/api/uploads/u1/a.mp4', durationSec: 2, startSec: 0, sourceInSec: 1, sourceOutSec: 3 },
    { nodeId: 'i1', type: 'image', title: '图1', url: '/api/uploads/u1/b.png', durationSec: 3, startSec: 0 },
    { nodeId: 'a1', type: 'audio', title: '配乐', url: '/api/uploads/u1/c.wav', durationSec: 8, startSec: 1, audioTrackIndex: 0, volume: 0.5 },
  ],
  export: { fileName: '成片', resolution: '1080p', format: 'mp4', volume: 1, muted: false, keepFullAudioTail: false },
})

describe('validateTimeline', () => {
  it('同轨重叠报错并带 nodeId', () => {
    const t = base()
    t.tracks.push({ ...t.tracks[2]!, nodeId: 'a2', startSec: 2 })
    const errors = validateTimeline(t)
    expect(errors.some((e) => e.includes('a2') && e.includes('overlap'))).toBe(true)
  })

  it('视觉轨为空报错', () => {
    const t = base()
    t.tracks = t.tracks.filter((x) => x.type !== 'video' && x.type !== 'image')
    expect(validateTimeline(t)).toContain('empty_visual_track')
  })

  it('非法裁剪区间报错', () => {
    const t = base()
    t.tracks[0]!.sourceOutSec = 0
    expect(validateTimeline(t).some((e) => e.includes('invalid_trim'))).toBe(true)
  })
})

describe('compileTimelineToEditly', () => {
  it('按 trackOrder 生成视觉轨且音频按 startSec 对齐', () => {
    const spec = compileTimelineToEditly(base(), {
      v1: '/tmp/v1.mp4', i1: '/tmp/i1.png', a1: '/tmp/a1.wav',
    })
    expect(spec.clips.map((c) => c.duration)).toEqual([2, 3])
    expect(spec.audioTracks).toEqual([
      { path: '/tmp/a1.wav', start: 1, cutFrom: 0, cutTo: 8, mixVolume: 0.5 },
    ])
    expect(spec).toMatchObject({ width: 1920, height: 1080, keepSourceAudio: true, outPath: '/tmp/out/成片.mp4' })
  })

  it('整体静音把所有音量置 0', () => {
    const t = base()
    t.export.muted = true
    const spec = compileTimelineToEditly(t, { v1: 'v', i1: 'i', a1: 'a' })
    expect(spec.outputVolume).toBe(0)
    expect(spec.audioTracks?.[0]?.mixVolume).toBe(0)
  })
})

it('visualDurationSec 只算视觉轨', () => expect(visualDurationSec(base())).toBe(5))
it('文件名清洗', () => expect(sanitizeTimelineFileName('../a:b/成片.mp4', 'mp4')).toBe('a_b_成片.mp4'))
```

- [x] **Step 2: 运行测试确认 RED**

```bash
cd /Users/4seven/workspace/pi-lnk/packages/shared && env -u NODE_OPTIONS ../../node_modules/.bin/vitest run src/canvas/videoTimeline.test.ts --maxWorkers=1 --no-file-parallelism
```

Expected: FAIL，提示模块不存在。

- [x] **Step 3: 实现纯函数**

`packages/shared/src/canvas/videoTimeline.ts`：

```ts
export type TimelineResolution = '720p' | '1080p' | '2k' | '4k'
export const TIMELINE_RESOLUTIONS: Record<TimelineResolution, { width: number; height: number }> = {
  '720p': { width: 1280, height: 720 },
  '1080p': { width: 1920, height: 1080 },
  '2k': { width: 2560, height: 1440 },
  '4k': { width: 3840, height: 2160 },
}

export interface TimelineTrack {
  nodeId: string
  type: 'video' | 'image' | 'audio'
  title: string
  url: string
  durationSec: number
  startSec: number
  sourceInSec?: number
  sourceOutSec?: number
  volume?: number
  muted?: boolean
  audioTrackIndex?: 0 | 1
  durationEstimated?: boolean
}

export interface TimelineExport {
  fileName: string
  resolution: TimelineResolution
  format: 'mp4' | 'mov'
  volume: number
  muted: boolean
  keepFullAudioTail: boolean
}

export interface VideoTimeline {
  version: 1
  clipCount: number
  trackOrder: string[]
  tracks: TimelineTrack[]
  export: TimelineExport
}

export type TimelineOp =
  | { op: 'add_visual'; node_id: string; at?: number; source_in_sec?: number; source_out_sec?: number; duration_sec?: number }
  | { op: 'add_audio'; node_id: string; audio_track_index: 0 | 1; start_sec: number; source_in_sec?: number; source_out_sec?: number; volume?: number; muted?: boolean }
  | { op: 'move_visual'; from: number; to: number }
  | { op: 'trim'; node_id: string; source_in_sec: number; source_out_sec: number; duration_sec?: number }
  | { op: 'set_volume'; node_id: string; volume: number; muted?: boolean }
  | { op: 'remove'; node_id: string }
  | { op: 'set_export'; file_name?: string; resolution?: TimelineResolution; format?: 'mp4' | 'mov'; volume?: number; muted?: boolean; keep_full_audio_tail?: boolean }
  | { op: 'request_render' }

export function visualDurationSec(t: VideoTimeline): number {
  const order = new Map(t.trackOrder.map((id, i) => [id, i]))
  return t.tracks
    .filter((x) => x.type === 'video' || x.type === 'image')
    .sort((a, b) => (order.get(a.nodeId) ?? 0) - (order.get(b.nodeId) ?? 0))
    .reduce((sum, x) => sum + x.durationSec, 0)
}

export function validateTimeline(t: VideoTimeline): string[] {
  const errors: string[] = []
  if (t.version !== 1) errors.push('unsupported_version')
  if (!t.tracks.some((x) => x.type === 'video' || x.type === 'image')) errors.push('empty_visual_track')
  for (const track of t.tracks) {
    if (!track.nodeId || !track.url) errors.push(`missing_source:${track.nodeId || 'unknown'}`)
    if (track.type === 'audio') {
      if (track.audioTrackIndex !== 0 && track.audioTrackIndex !== 1) errors.push(`invalid_audio_index:${track.nodeId}`)
      if (track.startSec < 0) errors.push(`invalid_start:${track.nodeId}`)
    }
    if (track.sourceInSec !== undefined || track.sourceOutSec !== undefined) {
      const i = track.sourceInSec ?? 0
      const o = track.sourceOutSec ?? track.durationSec
      if (i < 0 || o <= i) errors.push(`invalid_trim:${track.nodeId}`)
    }
    if ((track.volume ?? 1) < 0 || (track.volume ?? 1) > 2) errors.push(`invalid_volume:${track.nodeId}`)
  }
  for (const idx of [0, 1] as const) {
    const items = t.tracks
      .filter((x) => x.type === 'audio' && x.audioTrackIndex === idx)
      .sort((a, b) => a.startSec - b.startSec)
    for (let i = 1; i < items.length; i += 1) {
      const prev = items[i - 1]!
      const cur = items[i]!
      if (cur.startSec < prev.startSec + prev.durationSec) errors.push(`overlap:${cur.nodeId}`)
    }
  }
  return errors
}

export function sanitizeTimelineFileName(raw: string, format: 'mp4' | 'mov'): string {
  const cleaned = raw.replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').trim().slice(0, 120)
  const base = cleaned || 'video_timeline'
  return base.toLowerCase().endsWith(`.${format}`) ? base : `${base}.${format}`
}

export interface EditlySpec {
  outPath: string
  width: number
  height: number
  fps: number
  clips: Array<{ duration: number; layers: Array<Record<string, unknown>> }>
  audioTracks: Array<{ path: string; start: number; cutFrom: number; cutTo: number; mixVolume: number }>
  keepSourceAudio: boolean
  clipsAudioVolume: number
  outputVolume: number
}

export function compileTimelineToEditly(
  timeline: VideoTimeline,
  localPaths: Record<string, string>,
  outDir = '/tmp',
): EditlySpec {
  const errors = validateTimeline(timeline)
  if (errors.length) throw new Error(`invalid timeline: ${errors.join(',')}`)
  const order = new Map(timeline.trackOrder.map((id, i) => [id, i]))
  const visual = timeline.tracks
    .filter((x) => x.type === 'video' || x.type === 'image')
    .sort((a, b) => (order.get(a.nodeId) ?? 0) - (order.get(b.nodeId) ?? 0))
  const visualLen = visualDurationSec(timeline)
  const dims = TIMELINE_RESOLUTIONS[timeline.export.resolution]
  const fileName = sanitizeTimelineFileName(timeline.export.fileName, timeline.export.format)
  const clips = visual.map((track) => {
    const path = localPaths[track.nodeId]
    if (!path) throw new Error(`missing_local_source:${track.nodeId}`)
    if (track.type === 'image') {
      return { duration: track.durationSec, layers: [{ type: 'image', path }] }
    }
    const sourceIn = track.sourceInSec ?? 0
    const sourceOut = track.sourceOutSec ?? track.durationSec
    return {
      duration: sourceOut - sourceIn,
      layers: [{
        type: 'video', path, cutFrom: sourceIn, cutTo: sourceOut,
        mixVolume: track.muted ? 0 : (track.volume ?? 1),
      }],
    }
  })
  const volume = timeline.export.muted ? 0 : timeline.export.volume
  const audioTracks = timeline.tracks
    .filter((x) => x.type === 'audio')
    .map((x) => ({
      path: localPaths[x.nodeId] ?? '',
      start: x.startSec,
      cutFrom: x.sourceInSec ?? 0,
      cutTo: (x.sourceInSec ?? 0) + (
        timeline.export.keepFullAudioTail
          ? x.durationSec
          : Math.max(0, Math.min(x.durationSec, visualLen - x.startSec))
      ),
      mixVolume: volume * (x.muted ? 0 : (x.volume ?? 1)),
    }))
    .filter((x) => x.path)
  return {
    outPath: `${outDir}/${fileName}`,
    width: dims.width,
    height: dims.height,
    fps: 25,
    clips,
    audioTracks,
    keepSourceAudio: clips.some((c) => c.layers.some((l) => l.type === 'video' && Number(l.mixVolume ?? 0) > 0)),
    clipsAudioVolume: volume,
    outputVolume: volume,
  }
}
```

在 `packages/shared/src/index.ts` 增加 `export * from './canvas/videoTimeline'`。

- [x] **Step 4: 跑测试 PASS 并做变异验证**

```bash
cd /Users/4seven/workspace/pi-lnk/packages/shared && env -u NODE_OPTIONS ../../node_modules/.bin/vitest run src/canvas/videoTimeline.test.ts --maxWorkers=1 --no-file-parallelism
```

Expected: PASS。随后把 `validateTimeline` 的 overlap 判断临时改成 `false`，确认重叠用例转红，再恢复。

- [x] **Step 5: Commit**

```bash
git add packages/shared/src/canvas/videoTimeline.ts packages/shared/src/canvas/videoTimeline.test.ts packages/shared/src/index.ts
git commit -m "feat(video-timeline): add shared timeline model and editly compiler"
```

---

## Task 3: 服务端时间线服务、端点与任务快照

**Files:**
- Create: `apps/server/src/agent/video-timeline.service.ts`
- Create: `apps/server/src/agent/video-timeline.controller.ts`
- Create: `apps/server/src/agent/video-timeline.service.test.ts`
- Modify: `apps/server/src/agent/agent.module.ts`
- Modify: `apps/server/src/sessions/canvas-write-governance.test.ts`

**Interfaces:**
- Consumes: Task 2 的全部 shared 符号；`transactGovernedCanvasOps`、`MediaService`、`PersistRemoteService`。
- Produces: `POST /agent/internal/video-timeline/{create,edit,render,propose-render}`，返回 `{ok:true,data}` / `{ok:false,error,opIndex?}`。

- [x] **Step 1: 写失败测试**

```ts
import { VideoTimelineService } from './video-timeline.service'

// 三个用例共用 fake prisma / fake media / fake persist：
// 1) create 从 nodeIds 建草稿：canvas.nodes 新增 video 节点，data.timeline 存在且无 url，generationRecord.create 调用数 0
// 2) edit 同轨重叠：返回 ok:false + opIndex=1，canvasData 未被写
// 3) render 无 proposalKind：抛 BadRequestException，worker 未启动
```

测试文件用 `vi.fn()` 构造依赖，直接 `new VideoTimelineService(prisma as never, media as never, persist as never)`；不要起 Nest 应用。

- [x] **Step 2: 运行确认 RED**

```bash
cd /Users/4seven/workspace/pi-lnk/apps/server && env -u NODE_OPTIONS ./node_modules/.bin/vitest run src/agent/video-timeline.service.test.ts --maxWorkers=1 --no-file-parallelism
```

Expected: FAIL，模块不存在。

- [x] **Step 3: 实现 service 核心**

`video-timeline.service.ts` 最小骨架：

```ts
import { BadRequestException, ForbiddenException, Injectable, ServiceUnavailableException } from '@nestjs/common'
import { randomUUID } from 'crypto'
import {
  compileTimelineToEditly, validateTimeline, visualDurationSec,
  type TimelineOp, type VideoTimeline,
} from '@lnkpi/shared'
import { PrismaService } from '../prisma/prisma.service'
import { MediaService } from '../media/media.service'
import { PersistRemoteService } from '../assets/persist-remote.service'
import { transactGovernedCanvasOps } from '../sessions/canvas-op-write'

export interface TimelineResult { ok: boolean; data?: Record<string, unknown>; error?: string; opIndex?: number }

@Injectable()
export class VideoTimelineService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly media: MediaService,
    private readonly persist: PersistRemoteService,
  ) {}

  private renderEnabled(): boolean {
    return process.env.VIDEO_TIMELINE_RENDER_ENABLED === 'true'
  }

  async create(input: { sessionId: string; userId: string; title: string; sourceNodeIds: string[] }): Promise<TimelineResult> {
    if (!input.sourceNodeIds.length) return { ok: false, error: 'source_node_ids is required' }
    const session = await this.prisma.session.findFirst({ where: { id: input.sessionId, userId: input.userId } })
    if (!session) throw new ForbiddenException('无权访问该画布')
    const canvas = JSON.parse(session.canvasData ?? '{"nodes":[],"edges":[]}') as {
      nodes: Array<{ id: string; type: string; data: Record<string, unknown> }>
      edges: Array<{ id: string; source: string; target: string }>
    }
    const nodeMap = new Map(canvas.nodes.map((n) => [n.id, n]))
    const tracks = input.sourceNodeIds.map((nodeId, i) => {
      const node = nodeMap.get(nodeId)
      if (!node) return { ok: false as const, error: `unknown_node:${nodeId}` }
      if (!['video', 'image', 'audio'].includes(node.type)) return { ok: false as const, error: `unsupported_node_type:${nodeId}` }
      return {
        ok: true as const,
        track: {
          nodeId, type: node.type as 'video' | 'image' | 'audio',
          title: String(node.data.title ?? nodeId).slice(0, 48),
          url: String(node.data.url ?? ''),
          durationSec: node.type === 'audio' ? 3 : 5,
          startSec: node.type === 'audio' ? 0 : i,
          durationEstimated: true,
          ...(node.type === 'audio' ? { audioTrackIndex: 0 as const } : {}),
        },
      }
    })
    const failed = tracks.find((x) => !x.ok)
    if (failed) return { ok: false, error: failed.error }
    const built = tracks.map((x) => (x as { ok: true; track: VideoTimeline['tracks'][number] }).track)
    const visual = built.filter((x) => x.type === 'video' || x.type === 'image')
    const audio = built.filter((x) => x.type === 'audio')
    if (audio.length > 2) return { ok: false, error: 'audio_track_limit:2' }
    audio.forEach((track, i) => { track.audioTrackIndex = (i % 2) as 0 | 1 })
    const timeline: VideoTimeline = {
      version: 1,
      clipCount: visual.length,
      trackOrder: visual.map((x) => x.nodeId),
      tracks: built,
      export: { fileName: input.title || 'video_timeline', resolution: '1080p', format: 'mp4', volume: 1, muted: false, keepFullAudioTail: false },
    }
    const draftId = `vt_${randomUUID()}`
    const result = await transactGovernedCanvasOps(this.prisma, input.sessionId, (current) => ({
      ops: [
        {
          type: 'add_node' as const,
          payload: { id: draftId, nodeType: 'video', position: { x: 900, y: 120 }, data: {} },
        },
        ...built.map((t) => ({ type: 'add_edge' as const, payload: { source: t.nodeId, target: draftId } })),
        {
          type: 'update_node' as const,
          payload: { id: draftId, data: { title: input.title, status: 'draft', timeline } },
        },
      ],
    }), { onStaged: 'conflict' })
    if (result.outcome !== 'applied') return { ok: false, error: `canvas_write_${result.outcome}` }
    return { ok: true, data: { nodeId: draftId, trackCount: visual.length, estimatedVisualDurationSec: visualDurationSec(timeline) } }
  }

  async edit(input: { sessionId: string; userId: string; nodeId: string; ops: TimelineOp[]; save?: boolean }): Promise<TimelineResult> {
    const read = await this.readDraft(input.sessionId, input.userId, input.nodeId)
    if (!read.ok) return read
    const timeline = structuredClone(read.timeline!)
    for (let i = 0; i < input.ops.length; i += 1) {
      const op = input.ops[i]!
      if (op.op === 'request_render') continue
      if (op.op === 'remove') timeline.tracks = timeline.tracks.filter((t) => t.nodeId !== op.node_id)
      if (op.op === 'set_volume') {
        const t = timeline.tracks.find((x) => x.nodeId === op.node_id)
        if (!t) return { ok: false, error: `unknown_track:${op.node_id}`, opIndex: i }
        t.volume = op.volume; t.muted = op.muted ?? t.muted
      }
      if (op.op === 'set_export') {
        Object.assign(timeline.export, {
          fileName: op.file_name ?? timeline.export.fileName,
          resolution: op.resolution ?? timeline.export.resolution,
          format: op.format ?? timeline.export.format,
          volume: op.volume ?? timeline.export.volume,
          muted: op.muted ?? timeline.export.muted,
          keepFullAudioTail: op.keep_full_audio_tail ?? timeline.export.keepFullAudioTail,
        })
      }
      if (op.op === 'move_visual') {
        const [item] = timeline.trackOrder.splice(op.from, 1)
        if (!item) return { ok: false, error: 'invalid_move_index', opIndex: i }
        timeline.trackOrder.splice(op.to, 0, item)
      }
    }
    timeline.clipCount = timeline.trackOrder.length
    const errors = validateTimeline(timeline)
    if (errors.length) return { ok: false, error: errors.join(','), opIndex: input.ops.length - 1 }
    const patch: Record<string, unknown> = { timeline }
    if (input.ops.some((op) => op.op === 'request_render')) {
      Object.assign(patch, { status: 'pending_confirm', proposalKind: 'video_timeline_render', proposalEpoch: (read.epoch ?? 0) + 1 })
    }
    const result = await transactGovernedCanvasOps(this.prisma, input.sessionId, () => ({
      ops: [{ type: 'update_node', payload: { id: input.nodeId, data: patch } }],
    }), { onStaged: 'conflict' })
    if (result.outcome !== 'applied') return { ok: false, error: `canvas_write_${result.outcome}` }
    return { ok: true, data: { nodeId: input.nodeId, visualDurationSec: visualDurationSec(timeline), appliedOpCount: input.ops.length } }
  }

  private async readDraft(sessionId: string, userId: string, nodeId: string): Promise<{ ok: boolean; timeline?: VideoTimeline; epoch?: number; error?: string }> {
    const session = await this.prisma.session.findFirst({ where: { id: sessionId, userId } })
    if (!session) throw new ForbiddenException('无权访问该画布')
    const canvas = JSON.parse(session.canvasData ?? '{}') as { nodes?: Array<{ id: string; type: string; data: Record<string, unknown> }> }
    const node = canvas.nodes?.find((n) => n.id === nodeId)
    if (!node || node.type !== 'video' || !node.data.timeline) return { ok: false, error: 'timeline_draft_not_found' }
    return { ok: true, timeline: node.data.timeline as VideoTimeline, epoch: Number(node.data.proposalEpoch ?? 0) }
  }

  async render(input: { sessionId: string; userId: string; nodeId: string }): Promise<TimelineResult> {
    if (!this.renderEnabled()) throw new ServiceUnavailableException('VIDEO_TIMELINE_RENDER_ENABLED=false，渲染能力未启用')
    const session = await this.prisma.session.findFirst({ where: { id: input.sessionId, userId: input.userId } })
    if (!session) throw new ForbiddenException('无权访问该画布')
    const canvas = JSON.parse(session.canvasData ?? '{}') as { nodes?: Array<{ id: string; data: Record<string, unknown> }> }
    const node = canvas.nodes?.find((n) => n.id === input.nodeId)
    if (!node || node.data.status !== 'pending_confirm' || node.data.proposalKind !== 'video_timeline_render') {
      throw new BadRequestException('渲染需要先获得用户确认')
    }
    const timeline = node.data.timeline as VideoTimeline
    const validationErrors = validateTimeline(timeline)
    if (validationErrors.length) throw new BadRequestException(validationErrors.join(','))
    const record = await this.prisma.generationRecord.create({
      data: {
        userId: input.userId, type: 'video_timeline_render', prompt: String(node.data.title ?? 'video timeline'),
        model: 'editly@0.14.2', status: 'queued', sessionId: input.sessionId, nodeId: input.nodeId,
        metadata: JSON.stringify({ timeline, spec, createdAt: new Date().toISOString() }),
      },
    })
    return { ok: true, data: { generationRecordId: record.id, draftNodeId: input.nodeId, status: 'queued' } }
  }
}
```

- [x] **Step 4: controller 与模块注册**

`video-timeline.controller.ts`：

```ts
import { Body, Controller, Post, UseGuards } from '@nestjs/common'
import { AgentInternalGuard } from './agent-internal.guard'
import { VideoTimelineService } from './video-timeline.service'

@Controller('agent/internal')
@UseGuards(AgentInternalGuard)
export class VideoTimelineController {
  constructor(private readonly service: VideoTimelineService) {}

  @Post('video-timeline/create')
  create(@Body() dto: { sessionId: string; userId: string; title: string; sourceNodeIds: string[] }) {
    return this.service.create(dto)
  }

  @Post('video-timeline/edit')
  edit(@Body() dto: { sessionId: string; userId: string; nodeId: string; ops: unknown[]; save?: boolean }) {
    return this.service.edit({ ...dto, ops: dto.ops as never })
  }

  @Post('video-timeline/render')
  render(@Body() dto: { sessionId: string; userId: string; nodeId: string }) {
    return this.service.render(dto)
  }
}
```

在 `apps/server/src/agent/agent.module.ts`：imports 增 `MediaModule`；controllers 增 `VideoTimelineController`；providers 增 `VideoTimelineService`。

在 `canvas-write-governance.test.ts` 白名单新增一条，理由写「时间线草稿/成片写入统一走 transactGovernedCanvasOps，文件 = agent/video-timeline.service.ts」。

- [x] **Step 5: 跑测试 PASS**

```bash
cd /Users/4seven/workspace/pi-lnk/apps/server && env -u NODE_OPTIONS ./node_modules/.bin/vitest run src/agent/video-timeline.service.test.ts src/sessions/canvas-write-governance.test.ts --maxWorkers=1 --no-file-parallelism
```

Expected: PASS，且治理测试因白名单登记通过。

- [x] **Step 6: Commit**

```bash
git add apps/server/src/agent/video-timeline.*.ts apps/server/src/agent/agent.module.ts apps/server/src/sessions/canvas-write-governance.test.ts
git commit -m "feat(video-timeline): add server timeline service and internal endpoints"
```

---

## Task 4: pi-runtime 三工具、常驻归属与渲染确认门

**Files:**
- Create: `services/pi-runtime/src/tools/video-timeline.ts`
- Create: `services/pi-runtime/src/tools/video-timeline.test.ts`
- Modify: `services/pi-runtime/src/tools/registry.ts`
- Modify: `services/pi-runtime/src/tools/config.ts`
- Modify: `services/pi-runtime/src/tools/tiering.ts`
- Modify: `services/pi-runtime/src/gate/generation-gate.ts`
- Modify: `services/pi-runtime/src/gate/generation-gate.test.ts`
- Modify: `apps/web/src/components/agent/toolPresentation.ts`
- Create: `skills/video-timeline-editing/SKILL.md`

**Interfaces:**
- Consumes: Task 3 三个端点。
- Produces: 三个常驻工具；render 受 `proposalKind` 门控。

- [x] **Step 1: 写工具测试**

```ts
import { createVideoTimelineTools } from './video-timeline'

const client = { post: async (path: string, body: unknown) => {
  calls.push({ path, body })
  return { ok: true, data: { nodeId: 'vt_1', trackCount: 2, estimatedVisualDurationSec: 5 } }
} } as never
const tools = createVideoTimelineTools(client)
// 断言三个工具 name/tier 正确；create 把 sessionId/userId/source_node_ids 发出；
// edit 把 ops 原样转发；render 不带 confirm_render 字段。
```

- [x] **Step 2: 运行确认 RED**

```bash
cd /Users/4seven/workspace/pi-lnk/services/pi-runtime && env -u NODE_OPTIONS node --import tsx --test src/tools/video-timeline.test.ts
```

Expected: FAIL。

- [x] **Step 3: 实现工具**

```ts
import { Type } from 'typebox'
import type { LnkpiTool, LnkpiToolContext } from './types.js'
import type { NestClient } from './nest-client.js'

type Result = { content: Array<{ type: 'text'; text: string }>; details: undefined }
const result = (payload: unknown): Result => ({
  content: [{ type: 'text', text: JSON.stringify(payload) }], details: undefined,
})

export function createVideoTimelineTools(client: NestClient): LnkpiTool[] {
  return [
    {
      tier: 'write_light', name: "video_timeline_create",
      label: '创建视频时间线',
      description: 'Create a video timeline draft from existing canvas image/video/audio node ids. Does NOT render. Use when the user wants to assemble shots, mix images with video, or cut a short film.',
      summary: '把画布素材节点编成时间线草稿（不渲染）',
      parameters: Type.Object({
        title: Type.String({ description: 'Draft node title' }),
        source_node_ids: Type.Array(Type.String(), { description: 'Canvas node ids, in visual order' }),
      }),
      execute: async (_id, p: { title: string; source_node_ids: string[] }, _u, tc: LnkpiToolContext) => {
        try {
          const data = await client.post('/agent/internal/video-timeline/create', {
            sessionId: tc.sessionId, userId: tc.userId, title: p.title, sourceNodeIds: p.source_node_ids,
          })
          return result({ ok: true, ...(data as object) })
        } catch (err) {
          return result({ ok: false, error: err instanceof Error ? err.message : String(err) })
        }
      },
    },
    {
      tier: 'write_light', name: "video_timeline_edit",
      label: '编辑视频时间线',
      description: 'Edit a timeline draft: add/trim/reorder/remove clips, set audio start/volume, export settings, or request_render. Saving never starts rendering.',
      summary: '编辑时间线片段与导出设置',
      parameters: Type.Object({
        node_id: Type.String(),
        ops: Type.Array(Type.Object({ op: Type.String(), node_id: Type.Optional(Type.String()), at: Type.Optional(Type.Number()) }, { additionalProperties: true })),
        save: Type.Optional(Type.Boolean()),
      }),
      execute: async (_id, p: { node_id: string; ops: unknown[]; save?: boolean }, _u, tc: LnkpiToolContext) => {
        try {
          const data = await client.post('/agent/internal/video-timeline/edit', {
            sessionId: tc.sessionId, userId: tc.userId, nodeId: p.node_id, ops: p.ops, save: p.save,
          })
          return result({ ok: true, ...(data as object) })
        } catch (err) {
          return result({ ok: false, error: err instanceof Error ? err.message : String(err) })
        }
      },
    },
    {
      tier: 'gen', name: "video_timeline_render",
      label: '渲染视频时间线',
      description: 'Render a confirmed timeline draft into a final video node. Requires the draft to be in user-confirmed pending_confirm state; never call without user approval.',
      summary: '按已确认时间线渲染成片',
      parameters: Type.Object({ node_id: Type.String() }),
      execute: async (_id, p: { node_id: string }, _u, tc: LnkpiToolContext) => {
        try {
          const data = await client.post('/agent/internal/video-timeline/render', {
            sessionId: tc.sessionId, userId: tc.userId, nodeId: p.node_id,
          })
          return result({ ok: true, ...(data as object) })
        } catch (err) {
          return result({ ok: false, error: err instanceof Error ? err.message : String(err) })
        }
      },
    },
  ]
}
```

在 `registry.ts` 增加 `buildVideoTimelineTools(client)` 导出；在 `config.ts` 的 tools 数组增加 `...buildVideoTimelineTools(client)`；在 `tiering.ts` 的 `ALWAYS_ON_TOOL_NAMES` 增加三个名字。

- [x] **Step 4: 修改 generation-gate**

在 `GATED_TOOLS` 增加 `'video_timeline_render'`。把 `GateNode` 扩为 `data?: { status?: unknown; proposalKind?: unknown }`，增加：

```ts
function acceptsTimelineProposal(node: unknown): boolean {
  const d = (node as GateNode | null | undefined)?.data
  return d?.status === 'pending_confirm' && d?.proposalKind === 'video_timeline_render'
}
```

把两处 `extractNodeStatus(node) !== 'pending_confirm'` 改成：

```ts
if (extractNodeStatus(node) !== 'pending_confirm' || (toolName === 'video_timeline_render' && !acceptsTimelineProposal(node)))
```

同时在测试里新增：草稿态拒绝、`pending_confirm` 但无 proposalKind 拒绝、带 proposalKind 放行。

- [x] **Step 5: 展示与 skill 登记**

在 `toolPresentation.ts` 增加：

```ts
video_timeline_create: { icon: '🎬', verb: '编排时间线' },
video_timeline_edit: { icon: '✂️', verb: '剪辑时间线' },
video_timeline_render: { icon: '📤', verb: '渲染成片' },
```

新建 `skills/video-timeline-editing/SKILL.md`，正文必须逐字出现三个工具名，并写明：
1. 先 `video_timeline_create(source_node_ids)` 建草稿；
2. 用 `video_timeline_edit` 调整并 `request_render` 请求用户确认；
3. 用户确认后仅当节点 `status=pending_confirm` 且 `proposalKind=video_timeline_render` 才调 `video_timeline_render`；
4. 禁止自报确认、禁止传 URL。尾部保留 `## 工具可用性` 小节。

- [x] **Step 6: 跑门禁与测试**

```bash
cd /Users/4seven/workspace/pi-lnk/services/pi-runtime && env -u NODE_OPTIONS node --import tsx --test src/tools/video-timeline.test.ts src/gate/generation-gate.test.ts
cd /Users/4seven/workspace/pi-lnk && env -u NODE_OPTIONS ./node_modules/.bin/tsx scripts/verify-tool-tiering.ts
```

Expected: 全 PASS；A1/A2/A5 不红。

- [x] **Step 7: Commit**

```bash
git add services/pi-runtime apps/web/src/components/agent/toolPresentation.ts skills
git commit -m "feat(video-timeline): register timeline tools and confirmed render gate"
```

---

## Task 5: 画布时间线卡片与导出确认路由

**Files:**
- Create: `apps/web/src/components/canvas/VideoTimelineCard.vue`
- Create: `apps/web/src/components/canvas/VideoTimelineCard.test.ts`
- Modify: `apps/web/src/components/canvas/CanvasNodeVideo.vue`
- Modify: `apps/web/src/composables/useNodeGeneration.ts`
- Modify: `apps/web/src/utils/compositionUpstream.ts`

**Interfaces:**
- Consumes: `TimelineTrack` / `VideoTimeline`（Task 2）；`/agent/internal/video-timeline/render`（浏览器侧需经 Jwt 包装，见 Step 3）。
- Produces: `VideoTimelineCard` props `{ nodeId, timeline, status, renderEnabled }` / emits `request-render`。

- [x] **Step 1: 写卡片测试**

```ts
// mount VideoTimelineCard with tracks=[video 2s, image 3s, audio start=1]
// 断言：显示 00:05/00:05；视觉片段按 trackOrder 排列；编辑按钮 disabled；
// renderEnabled=false 时导出按钮 disabled 且 title 含“渲染未启用”。
```

- [x] **Step 2: 运行确认 RED**

```bash
cd /Users/4seven/workspace/pi-lnk/apps/web && env -u NODE_OPTIONS ./node_modules/.bin/vitest run src/components/canvas/VideoTimelineCard.test.ts --maxWorkers=1 --no-file-parallelism
```

Expected: FAIL。

- [x] **Step 3: 实现卡片**

`VideoTimelineCard.vue` 用 `defineProps<{ nodeId: string; timeline: VideoTimeline; status: string; renderEnabled: boolean }>()` 与 `defineEmits<{ 'request-render': [] }>()`。模板结构：

```
[标题 + 00:mm/00:mm + 音量图标 + 导出按钮]
[时间标尺 0:00/0:05...]
[视觉轨：v-for trackOrder 映射的 track，宽度 = durationSec / total * 100%，背景图用 track.url]
[音频轨 0/1：按 startSec 百分比定位的色块]
[底部：resolution · format · fileName]
```

样式只用现有类 `.neo-gen-card` / `.nodrag` 与 design-tokens 变量，例如 `var(--lnk-surface-2)`、`var(--lnk-border-subtle)`、`var(--lnk-text-primary)`（实际名字以 `design-tokens.css` 中存在者为准，禁止新 hex）。编辑图标 disabled + title「用 agent 编辑时间线」。

- [x] **Step 4: 接入 CanvasNodeVideo.vue 与确认路由**

在 `CanvasNodeVideo.vue` props.data 增加 `timeline?: unknown`、`proposalKind?: string`。在模板最外层 `<NeoBaseNode>` 内、`div.neo-gen-card` 之前插入：

```vue
<VideoTimelineCard
  v-if="timelineCard"
  :node-id="id"
  :timeline="timelineCard"
  :status="data.status"
  :render-enabled="renderEnabled"
  @request-render="requestRender"
/>
<div v-else class="neo-gen-card ...">…原模板逐字节不变…</div>
```

`timelineCard = computed(() => isVideoTimeline(props.data.timeline) ? props.data.timeline : null)`；`isVideoTimeline` 做最小结构校验（version=1、数组存在）。`renderEnabled = import.meta.env.VITE_VIDEO_TIMELINE_RENDER_ENABLED === 'true'`，构建时默认 false；卡片导出按钮先走 `propose-render` 端点写入确认事实，再由 `useNodeGeneration` 的确认按钮按 `proposalKind==='video_timeline_render'` 调 render 端点，禁止落回普通 `studioApi.generateVideo`。扩容启用渲染时必须同时设置该构建变量并重新发 web。

在 `apps/web/src/utils/compositionUpstream.ts`：把 `CompositionTrackType` 改为 `'video' | 'image' | 'audio'`；`inferNodeTrackType` 识别 image；`defaultDuration` 对 image 返回 5；`compositionTracksToNodePatch` 透传新增字段。保留既有函数签名，避免消费者回归。

- [x] **Step 5: 跑定向测试与静态契约**

```bash
cd /Users/4seven/workspace/pi-lnk/apps/web && env -u NODE_OPTIONS ./node_modules/.bin/vitest run src/components/canvas/VideoTimelineCard.test.ts src/utils/compositionUpstream.test.ts --maxWorkers=1 --no-file-parallelism
cd /Users/4seven/workspace/pi-lnk && env -u NODE_OPTIONS ./node_modules/.bin/tsx scripts/verify-tool-tiering.ts
```

Expected: PASS；现有无 timeline 的视频节点回归测试保持绿。

- [x] **Step 6: Commit**

```bash
git add apps/web/src/components/canvas apps/web/src/composables/useNodeGeneration.ts apps/web/src/utils/compositionUpstream.ts
git commit -m "feat(video-timeline): add canvas timeline card and export routing"
```

---

## Task 6: 渲染 worker、部署开关与生产取证

**Files:**
- Create: `apps/server/src/agent/video-timeline.worker.ts`
- Modify: `deploy/docker/Dockerfile.api`
- Modify: `deploy/docker-compose.prod.yml`
- Create: `deploy/video-timeline/prod-verify.py`

**Interfaces:**
- Consumes: `GenerationRecord.metadata` 冻结 spec；`MediaService` / `PersistRemoteService`。
- Produces: 单独的 worker 进程；扩容后 `VIDEO_TIMELINE_RENDER_ENABLED=true` 才启用。

- [ ] **Step 1: worker 实现**

`video-timeline.worker.ts` 用 `NestFactory.createApplicationContext(VideoTimelineWorkerModule)`，模块只 import `PrismaModule/MediaModule/AssetsModule`，provider 为 `VideoTimelineWorkerService`。服务每 3 秒轮询：

```ts
const job = await prisma.generationRecord.findFirst({
  where: { type: 'video_timeline_render', status: 'queued' },
  orderBy: { createdAt: 'asc' },
})
```

拿到后：
1. `update status='generating'`；
2. 从 `metadata` 读 `{timeline, spec}`；
3. 每条 track 调 `media.resolveDownloadSource(userId, track.url, undefined, sessionId)` + `openDownloadStream()` 写入 `tmp/<nodeId>` 文件；
4. 用 `localPaths` 重新 `compileTimelineToEditly`，`spec.outPath = tmp/out/<sanitized>`；
5. `await editly(spec)`；
6. 若 `!keepFullAudioTail`，用 `ffprobe` 校验输出时长 ≤ 画面时长 + 0.5s，否则失败；
7. 将产物复制成 `uploads/<userId>/vt_<uuid>.<format>`，调 `persist.persistRemote({userId,url:'/api/uploads/...',kind:'video',sessionId,generationRecordId})`；
8. `transactGovernedCanvasOps` 建独立成片视频节点（url/mediaInfo/sourceTimelineNodeId/generationRecordId）+ `add_edge` 草稿→成片；
9. `generationRecord.update({status:'succeeded',url,metadata:...})`；失败更新 `status='failed'` 与 errorMessage。

进程内 `semaphore=1`，4K 任务在 `resolution='4k'` 时直接失败并提示资源不足。

- [ ] **Step 2: Dockerfile 与 compose**

`Dockerfile.api` 已安装 ffmpeg，不改 apt 行；build 阶段需能编译 Editly 原生依赖，在 runner 不再装 build-essential。runner 增加：

```
ENV VIDEO_TIMELINE_RENDER_ENABLED=false
```

`docker-compose.prod.yml` 增加 `video-timeline-worker` 服务，复用 `lnkpi-api` 镜像、同一 env 文件、command 指向 `node dist/apps/server/video-timeline.worker.js`，`deploy.resources.limits.memory: 2G`，并依赖 `lnkpi-api` healthy。扩容前该服务 `profiles: ["video-timeline"]`，默认不启动。

- [ ] **Step 3: 生产取证脚本**

`deploy/video-timeline/prod-verify.py` 用真实会话通过 HTTP：
1. `POST /api/sessions` 自建画布；
2. 3 个镜头 + 1 张图 + 2 条音轨；
3. 调 create/edit/request-render/render，断言草稿无 url、成片有 url；
4. 请求 `/api/media/stream-download` 下载产物，本地 `ffprobe` 校验 1280×720 与时长；
5. 打印 `ALL_PASS` 或逐条 FAIL。

脚本读取 `VIDEO_TIMELINE_RENDER_ENABLED` 对应的健康端点；false 时只验证「导出按钮禁用 + render 503」，不把未启用当失败。

- [ ] **Step 4: 本地与 CI 验证**

```bash
pnpm -r build
pnpm test:server:changed
pnpm test:runtime
```

Expected: 全绿；`verify-tool-tiering` 与 `verify-spec-figures` 全绿。

- [ ] **Step 5: Commit / PR / 部署**

按 `docs/agent/delivery.md` 七步流程：squash 合并后手工发 `runtime-deploy.yml`（tag = master 短 SHA）；api/web 走 `deploy.yml`。生产保持 `VIDEO_TIMELINE_RENDER_ENABLED=false`，先跑 `prod-verify.py` 禁用态判据；扩容到 ≥8G 且磁盘清理后再开 worker profile 并跑全量判据。

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/agent/video-timeline.worker.ts deploy/docker deploy/video-timeline
git commit -m "feat(video-timeline): add render worker and gated deployment"
```

---

## Self-Review

- 规格 §2 的 7 项目标逐项落在 Task 1/2/3/5/6。
- 规格 §5 三工具契约落在 Task 4；常驻与 skill 点名的修订已回写规格。
- 规格 §6 编译规则、素材归属、产物落库、资源门槛落在 Task 1/2/3/6。
- 规格 §7 UI 与状态落在 Task 5。
- 规格 §9 测试与生产取证落在每 Task 的测试步骤与 Task 6。
- 唯一保留风险：MOV/2K/4K 需 Task 1 spike 通过后才开放；未通过时 UI 与服务端均禁用，不写死未经验证的 codec 参数。
