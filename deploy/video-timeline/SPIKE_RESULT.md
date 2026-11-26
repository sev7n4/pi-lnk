# 视频时间线 Editly spike 取证（Task 1 / 2026-11-26）

## 结论

**采用 `editly@0.14.2` + FFmpeg 5.1.9（Debian bookworm 包）作为渲染内核；首期只开放 720p/1080p MP4。**
MOV / 2K / 4K 未取证，服务端 allowlist 与 UI 均不开放（服务端 `set_export` 直接拒绝，见 `video-timeline.service.ts`）。

## 实跑环境

- 镜像：`editly-spike:local`（node:22-bookworm + ffmpeg/xvfb + canvas/gl 原生工具链 + `npm install editly@0.14.2`）
- 运行命令（⚠️ 必须文件级挂载，目录整体挂 `/work` 会遮蔽镜像内 `/work/node_modules`）：

```bash
docker run --rm -v "$PWD/deploy/video-timeline/spike.mjs":/work/spike.mjs:ro -w /work \
  editly-spike:local bash -lc 'xvfb-run -a node spike.mjs'
```

- 脚本：`deploy/video-timeline/spike.mjs`（2 video clips + 1 image clip + 2 arbitrary audio tracks，bgm 8s 超长、vo 2s 起点对齐）

## 实测输出

```
ffmpeg version 5.1.9
ffprobe version 5.1.9
1280x720 25fps
{
  "ok": true,
  "probe": {
    "streams": [
      { "codec_name": "h264", "width": 1280, "height": 720 },
      { "codec_name": "aac" }
    ],
    "format": { "duration": "7.000000" }
  }
}
NODE_EXIT=0
```

判据逐条：
1. ✅ 视觉总长 = 2s + 3s(image) + 2s = 7s，输出 `format.duration=7.000000`（音频被裁到画面结束，bgm 8s 未溢出）。
2. ✅ 分辨率 1280×720、视频 h264、音频 aac（MP4 容器）。
3. ✅ 2 条 audio track 混音成功（bgm `cutFrom:0/cutTo:7`、vo `start:2/cutTo:2`）。
4. ✅ image clip 用真实 PNG（jsdom `<img>` 不认 mp4，首次用 mp4 时报 `Unsupported image type` 且该片段被丢弃 → 6s；已修正脚本为 PNG）。

## 关键发现（已回写编译器与测试）

**editly 默认转场会吃掉时长**：默认每 clip 带 0.5s transition，3 clips ⇒ `7 - 2×0.5 = 6s`（首次实测即 6.000000）。
本项目语义是「片段顺序拼接、时长精确对齐」，因此 `compileTimelineToEditly()` 显式输出 `defaults: { transition: null }`；
spike 脚本同步加该字段后输出恢复 7.000s。shared 单测锁 `spec.defaults === { transition: null }`，防回归。

## 许可与编译选项

- `editly@0.14.2`：MIT，可商用。固定版本，禁止升级 latest。
- FFmpeg 5.1.9（Debian bookworm 包）：`configuration` 含 `--enable-gpl --enable-libx264 --enable-libx265`，**不含 `--enable-nonfree`** ✅。
  - 因启用 GPL 组件，组合产物按 GPL 处理；部署文档需登记许可与源码提供义务（规格 §6.3）。本项目不分发二进制、仅服务端运行生成内容，不触发分发义务。
- Remotion（非 OSI，公司需 Company License）/ OpenCut（重写中）/ FFCreator（停更）/ MLT（许可复杂）均不采用。

## 首期允许格式

| 项 | 状态 | 依据 |
|---|---|---|
| MP4 / 720p / 1080p | ✅ 开放 | 本次 spike 取证（1280×720 h264+aac） |
| MOV | ❌ 不开放 | editly 文档 `.mov` 仅作输入示例；未取证 codec 参数 |
| 2K / 4K | ❌ 不开放 | 未取证 + CVM 内存未扩容；4K worker 直接失败 |

## 依赖落地方式（≠ 原计划）

原计划把 editly 加进 `apps/server/package.json` + pnpm lock；实施期发现会与 jsdom 的 `canvas@^3` peer 冲突、污染 pnpm 解析图且 CI 无 cairo 头文件会红。
**实际**：Dockerfile.api 在 `/opt/editly` 用 npm 隔离安装，runner `ENV NODE_PATH=/opt/editly/node_modules`；
TS `module: CommonJS` 下 `import('editly')` 降级为 `require('editly')`，NODE_PATH 生效（已用 `ts.transpileModule` 验证）。`package.json`/lockfile 不改。
