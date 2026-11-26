# Runbook：视频编辑时间线渲染能力启用（CVM 扩容后）

> 适用对象：CVM 已扩容到 **≥8G 可用内存**并完成磁盘清理后，才可执行本 runbook。
> 背景：渲染 worker 是 editly + FFmpeg 的原生进程，实测单任务峰值内存显著；当前 CVM
> 3.6Gi 总内存、可用不足 500Mi 时**禁止启用**，否则 OOM 会连带打挂 api。
> spec：`docs/superpowers/specs/2026-11-25-video-timeline-editor-design.md` §6.4；
> 取证：`deploy/video-timeline/SPIKE_RESULT.md`（editly 0.14.2 + FFmpeg 5.1.9，7s/1280×720 h264+aac PASS）。

## 前置检查（不满足则停止）

```bash
ssh deploy-cvm 'free -h | head -2; df -h / | tail -1; swapon --show | head -3'
```

判据：可用内存 ≥ 4G（推荐 8G 总内存、可用 ≥ 5G），根分区余量 ≥ 6G。不满足者先扩容/清理，
不要往下走。`--profile video-timeline` 的 worker 设了 `mem_limit: 2g`，但宿主内存不足时
仍会触发整机 OOM killer。

## 三个开关必须同步（缺一即"假上线"）

| 开关 | 作用域 | 生效方式 | 默认值 |
| --- | --- | --- | --- |
| `VIDEO_TIMELINE_RENDER_ENABLED` | 后端（api render 端点） | CVM `/opt/lnkpi/.env` + api 容器 recreate | `false` |
| `video-timeline` compose profile | worker 进程 | `docker compose --profile video-timeline up -d` | 不启 |
| `VITE_VIDEO_TIMELINE_RENDER_ENABLED` | 前端（卡片导出按钮） | **构建期**变量，重建 web | `false` |

三者不一致的两类假失败：**后端开、前端关** → 按钮灰色，用户以为没上线；**前端开、后端/worker 关** →
按钮可点但 render 返回 503。必须同时打开。

## 步骤

### 1. 打开后端开关（运行时，无需重建镜像）

```bash
ssh deploy-cvm 'cd /opt/lnkpi && \
  grep -q "^VIDEO_TIMELINE_RENDER_ENABLED=" .env \
    && sed -i "s/^VIDEO_TIMELINE_RENDER_ENABLED=.*/VIDEO_TIMELINE_RENDER_ENABLED=true/" .env \
    || echo "VIDEO_TIMELINE_RENDER_ENABLED=true" >> .env; \
  grep VIDEO_TIMELINE_RENDER_ENABLED .env'
```

api 容器的 `env_file: ../.env` 只在容器**创建时**读取；改完 `.env` 必须 recreate 才生效：

```bash
ssh deploy-cvm 'cd /opt/lnkpi && \
  IMG=$(docker inspect -f "{{.Config.Image}}" lnkpi-api) && \
  echo "recreating api with $IMG" && \
  LNKPI_API_IMAGE="$IMG" docker compose -f deploy/docker-compose.prod.yml up -d --no-build --force-recreate api'
```

> ⚠️ 必须显式传当前镜像名：compose 的 `image: ${LNKPI_API_IMAGE:-lnkpi-api:local}` 在不传时
> 会回退到 `lnkpi-api:local`，而生产实际跑的是带 SHA tag 的镜像——不传等于悄悄降级。

判据：api 容器内 `node -e "console.log(process.env.VIDEO_TIMELINE_RENDER_ENABLED)"` 输出 `true`；
或完整判据走第 4 步取证脚本（render 不再返回 503），不必手动构造请求。

### 2. 启动渲染 worker（profile 默认不启）

```bash
ssh deploy-cvm 'cd /opt/lnkpi && \
  IMG=$(docker inspect -f "{{.Config.Image}}" lnkpi-api) && \
  LNKPI_API_IMAGE="$IMG" docker compose -f deploy/docker-compose.prod.yml --profile video-timeline up -d --no-build video-timeline-worker && \
  docker ps --format "{{.Names}} {{.Status}}" --filter name=lnkpi-vt-worker'
```

worker 复用 api 镜像（内含 `/opt/editly` + NODE_PATH），entrypoint 覆盖为
`xvfb-run -a node dist/video-timeline.worker.js`，并发 1、`mem_limit: 2g`、依赖 api healthy。
判据：容器 Up 且日志无 `NODE_PATH`/`editly` 解析错误
（`docker logs --tail 30 lnkpi-vt-worker`）。

### 3. 重建并发布 web（打开前端导出按钮）

用带开关的 workflow_dispatch（**不要**直接 push，避免误触发整栈）：

```bash
gh workflow run deploy.yml -R sev7n4/pi-lnk \
  -f branch=master -f deploy_web_only=true -f enable_video_timeline_render=true
gh run watch <run-id> -R sev7n4/pi-lnk --exit-status --interval 20
```

判据：`index.html` Last-Modified 更新；产物 chunk 同时含 `渲染成片` 与 `渲染未启用` 两个分支字面量
（证明开关分支已编入 bundle）。但**字符串存在 ≠ 当前值为 true**——运行时必须打开一个含时间线草稿节点的画布，
检查导出按钮 `title` 变为 `渲染成片` 且非 `disabled`（构建期值为 false 时 title 是 `渲染未启用…`）。

### 4. 启用态生产取证

```bash
EXPECT_RENDER=1 python3 deploy/video-timeline/prod-verify.py
```

判据：打印 `ENABLE_ALL_PASS`，覆盖 render 入队 → 轮询 `/studio/generations/:id` 到终态 →
成功 → 画布生成独立 `vf_` 成片节点且草稿保留。
失败时脚本打印每步 HTTP 码与响应片段，按 `FAIL` 项定位；不要靠"看起来成功"放行。

## 回滚（回到禁用态）

```bash
ssh deploy-cvm 'cd /opt/lnkpi && \
  sed -i "s/^VIDEO_TIMELINE_RENDER_ENABLED=.*/VIDEO_TIMELINE_RENDER_ENABLED=false/" .env && \
  docker compose -f deploy/docker-compose.prod.yml --profile video-timeline stop video-timeline-worker && \
  docker compose -f deploy/docker-compose.prod.yml up -d --no-build --force-recreate api'
gh workflow run deploy.yml -R sev7n4/pi-lnk -f deploy_web_only=true   # 不带 enable 变量 ⇒ 重建回灰按钮
```

回滚后重跑无 `EXPECT_RENDER` 的 `prod-verify.py`，应得到 `DISABLED_ALL_PASS`。

## 已知非阻塞项

- `agent-canvas-tools.service.ts` 的 `voiceProfileRecord` 类型：本地 worktree 未跑
  `prisma generate` 时 tsc 会报 `PrismaService` 缺该字段；CI/deploy workflow 的
  Build 步骤均先执行 `pnpm --filter @lnkpi/server exec prisma generate`，生成后全绿。
  本地复现同样先跑 generate 即可，非代码缺陷。
