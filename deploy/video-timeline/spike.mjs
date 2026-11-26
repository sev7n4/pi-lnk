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
// 图片层必须是真实图片：jsdom 的 <img> 不认 mp4，实测 "Unsupported image type" 会让该片段被丢弃。
run('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'color=c=green:s=320x180:d=1', '-frames:v', '1', join(dir, 'still.png')])
run('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=8', join(dir, 'bgm.wav')])
run('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'sine=frequency=880:duration=8', join(dir, 'vo.wav')])

await editly({
  outPath: out,
  width: 1280,
  height: 720,
  fps: 25,
  // ⚠️ editly 默认 0.5s 转场会吃掉时长：3 clips ⇒ 7s-2×0.5=6s（实测）。
  // 本项目需要「片段顺序拼接、时长精确对齐」，必须显式禁用（编译器已同步写 defaults.transition=null）。
  defaults: { transition: null },
  keepSourceAudio: false,
  clips: [
    { duration: 2, layers: [{ type: 'video', path: join(dir, 'a.mp4'), cutFrom: 0, cutTo: 2, mixVolume: 0 }] },
    { duration: 3, layers: [{ type: 'image', path: join(dir, 'still.png') }] },
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
