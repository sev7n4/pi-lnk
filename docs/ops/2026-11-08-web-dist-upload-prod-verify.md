# Web dist 增量上传 · 生产验收记录（#2 部署链治理）

本文档不含图（理由：纯运维取证数据与判据，无结构图 / 视觉稿对象）。

状态：**已闭环（2026-11-08）**
前置规格：`docs/superpowers/specs/2026-11-08-web-dist-incremental-upload-design.md`
实施计划：`docs/superpowers/plans/2026-11-08-web-dist-incremental-upload.md`
上游：`docs/superpowers/specs/2026-11-08-follow-up-tail-abort-rejection-design.md` §12、`docs/ops/2026-11-08-phase3-prod-smoke.md` §4 / §6
合并：PR #781 → squash `0f6eaf58998deb825e476082297f4618300214c2`
自动部署 run：`42465888033`（push master 触发，`Deploy web to CVM` job id `128685233073`）

## 1. 判据与结果

| # | 规格 §10 门槛 | 实测 | 结论 |
| --- | --- | --- | --- |
| V1 | `Upload web dist and nginx config` ≤ 8 min | **2.63 min**（09:11:10 → 09:13:43 UTC） | PASS |
| V2 | 日志出现清单校验成功标记 | `UPLOAD_MODE=incremental` → `MANIFEST_OK files=163` → `WEB_DIST_UPLOAD_OK` | PASS |
| V3 | 远端逐文件自洽 | `/tmp/lnkpi-web-manifest.sha256` 163 行，`sha256sum -c` **exit 0** | PASS |
| V4 | 生产健康 | 本机与外网 `/` 200、`/api/health` 200 | PASS |
| V5 | #723 分享 OG 卡语义 | `/opt/lnkpi/share/share-og-default.png` 更新至 17:13、`-rw-r--r--`、HTTP 200 | PASS |
| V6 | 交付物集合不变 | 163 文件 / 24 MB；`index.html` mtime 14:14 → 17:11 | PASS |

## 2. 定量对照

| 指标 | 合并前（历史 deploy runs） | 本次 |
| --- | --- | --- |
| `Upload web dist` 耗时 | 3.08 min（`42435277817`）/ 8.07 min 被取消（`42442096327`）/ **15.05 min**（`42453812598`） | **2.63 min** |
| `Deploy web to CVM` job 总时长 | 4.63 / 9.58 / 16.87 min | **5.55 min** |
| 传输内容 | 每次全量 16–19 MB tar（含 15.6 MB 从不变化的登录动画 mp4） | 仅内容变化的文件（rsync `--checksum`） |
| 上传后完整性 | 无（`tar -xzf` 成功即视为成功） | `sha256sum -c` 163 文件硬校验，失败即阻断 nginx 配置 |

步骤明细（UTC）：`Build web` 1.13 min → `Prepare SSH` 0.02 → **Upload 2.63** → `Configure nginx` 0.17 → `Verify web deployment` 0.17。job `success`。

## 3. 取证原文

部署 job 日志（`gh api .../actions/jobs/128685233073/logs`）：

```
2026-11-08T09:11:10.5103252Z UPLOAD_MODE=incremental
2026-11-08T09:13:39.8576403Z MANIFEST_OK files=163
2026-11-08T09:13:43.0232575Z WEB_DIST_UPLOAD_OK
```

CVM 侧（合并前基线：163 文件 / 24 MB / `index.html` 14:14:22 / OG 卡 14:29）：

```
files=163
24M     .
index 2026-11-08 17:11:04.063876121 +0800 3635
-rw-r--r-- 1 root root 16707 Nov  8 17:13 /tmp/lnkpi-web-manifest.sha256
163 /tmp/lnkpi-web-manifest.sha256
./index.html: OK                      # sha256sum -c 全量输出末尾，exit 0
-rw-r--r-- 1 root root 31802 Nov  8 17:13 /opt/lnkpi/share/share-og-default.png
og_http=200 web=200 api=200
```

外网：`http://119.29.173.89:8888/` 200、`/api/health` 200。

## 4. 合并前后链路差异核对

| 契约 | 旧链路 | 新链路实测 |
| --- | --- | --- |
| 发布目录 | `/opt/lnkpi/web/dist` | 同 |
| 旧 hash chunk | `rm -rf assets` | 同（无 `--delete`，`brand/` 等历史文件保留） |
| nginx 配置 | `cp` + `chmod +x deploy-web.sh` | 同，`nginx -t` + restart 成功 |
| OG 卡 | `cp -f` 到 SHARE_DIR + `chmod 644` | 同，HTTP 200 |
| 临时文件清理 | tgz / nginx.conf / deploy-web.sh / OG 卡 | 同；新增 manifest 保留供 `VERIFY_ONLY=1` 复验 |

## 5. 对规格 §10 的显式修订（避免规格-实现漂移）

规格 §10 原写「合并后自动部署验收 **随后再手工 `workflow_dispatch` 一次 `deploy_web_only=true` 做对照**」。**本次未执行第二次派发**，理由与决策记录：

1. `deploy-web` job 的两条触发分支（`push` + `changes.outputs.web` 与 `workflow_dispatch` + `deploy_web_only`）在 `if:` 之后共用**同一段脚本、同一组 env、同一批 steps**；第二次运行不新增代码路径覆盖，唯一增量信息是链路耗时方差。
2. 本次 push 同时改了 `package.json`，触发 `Build API on CVM` 长任务仍在运行；`concurrency: lnkpi-release` + `cancel-in-progress: false` 会让新派发排队，且会再执行一次 `nginx restart` 制造额外生产窗口。
3. 风险与消耗大于收益 ⇒ **主判据确定为这一次真实 push 自动部署**（V1–V6 全部 PASS），`deploy_web_only` 对照降为**可选**：后续若需要链路方差数据、或改动了 `deploy-web` 的触发分支时，再单独派发并登记。

规格 §10 已同步改写为本结论；不追溯改写规格中「零行为变更」「冻结边界」等其它判据。

## 6. 范围边界与未覆盖

- 整条 deploy run `42465888033` 最终 **success**：`Build API on CVM` 11.5 min（Sync source 5.68 / Wait for CVM build 4.12）、`Deploy web to CVM` 5.55 min，两 job 并行。API job 属 API 部署链，与 web 上传治理无关；本记录 V1–V6 只对 web job 下结论。
- 未做 `LNKPI_WEB_UPLOAD_LEGACY=1` 的**生产**回退演练（只在本地行为级测试 S5 / S6 覆盖）；生产回退演练需另择窗口，避免无谓再动 nginx。
- 未做 staging 原子发布、上传字节数写进 `$GITHUB_STEP_SUMMARY`：均已登记为规格 §12 后续包。
- 本地 `pnpm test` 的 6 个 server SQLite 集成文件在并行批次撞 10s hook timeout，单独重跑 30/30 PASS；CI `Build monorepo` 全量通过（9m42s），以 CI 为准。

## 7. 结论

**#2 部署链治理在生产闭环**：上传步骤从最坏 15.05 min 降到 **2.63 min**（低于历史最快 3.08 min），并首次具备「上传后逐文件完整性硬失败」能力；发布目录语义、nginx 链、#723 OG 播种与交付物集合全部与旧链路一致。无回退、无手动兜底、无 rerun。
