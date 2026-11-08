# Web dist 增量上传与完整性校验 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

spec-figures: off —— 理由：实施计划按 writing-plans 模板组织，结构图已在同名 spec 的 §0 / §5 承载，计划不重复配图。

**Goal:** 把 `deploy-web` 的跨公网上传从「每次全量 16–19 MB tar」改成「按内容差量同步 + 上传后 sha256 清单校验」，缩短上传步骤并让不完整发布变成硬失败；用一个可测脚本承载全部逻辑，独立小 PR 落地。

**Architecture:** 不动发布目录语义、不动 nginx 链、不动 job 编排。新增 `deploy/upload-web-dist.sh`，把 `deploy.yml` 上传步骤的内联 6 行换成一次脚本调用；脚本支持注入远端执行器 / 复制器 / 同步日志，使 `scripts/verify-web-upload.py` 能在本地端到端跑真实 `rsync` 与 `sha256sum`；`LNKPI_WEB_UPLOAD_LEGACY=1` 一键回到原 tar + scp 路径。

**Tech Stack:** Bash、Python 3、rsync、sha256sum、GitHub Actions、pnpm、`gh api` Git-Data 链、Chrome headless CDP（仅生产复验沿用 P0 脚本）。

**Spec:** `docs/superpowers/specs/2026-11-08-web-dist-incremental-upload-design.md`（执行者须同时读 F1 规格 §12 与 P0 报告 §6 了解结论修订）。

## Global Constraints

- master 真值只认 `gh api`（本计划开工时 `4a5aa564e050355458c4775e50098d98b0651eb5`）；本地 ref / 工作树可能漂移，推前逐路径核对裸 blob sha。
- `gh api` Git-Data tree entry **必须 repo-root 相对**（`.github/workflows/deploy.yml`、`deploy/upload-web-dist.sh`）；app 相对路径会产生幻影文件（#774 事故）。
- `gh api` 读也可能 502 ⇒ 所有读写都带 retry / backoff。
- 本机 vitest / vue-tsc / pnpm 用 `export PATH=/Users/4seven/.nvm/versions/node/v24.13.0/bin:$PATH` 且 `unset NODE_OPTIONS`；`nvm use 24` 单独不足以绕过 WorkBuddy 的 node22 shim。
- vitest 加 `--maxWorkers=1 --no-file-parallelism`；`pnpm -r build` 的 tsc 会编译 `*.test.ts` ⇒ 测试断言禁用 `as never`。
- CI 三个 required check = `Verify spec figures` / `Build monorepo` / `Build API Docker image`。
- 判据必须能真的失败：基线 RED 且 exit≠0；每条变异真改变输出后 RED；测试跑真实脚本 + 真实 rsync，禁止用 workflow 文本断言充当主判据。
- 本机 `grep -rn` 可能被 shim 包装返回假阴性 ⇒ 一律 Python 直读复核。
- 本刀改 `.github/workflows/deploy.yml` 与 `package.json`，两者都在 deploy paths 白名单内 ⇒ 合并会触发自动部署；`environment: production` 可能挂审批，按闸门纪律处理，不绕过、不并行推其他发布。
- 不改 `deploy/deploy-web.sh`、`deploy/nginx.conf`、`docs/agent/*.md`、`docs/superpowers/INDEX.md`、`prompt-registry/**`、任何 `apps/web/**` 产品源码。
- 本地 `apps/web/dist` 与 CI 产物哈希不同 ⇒ 只用于体积测量，绝不上传生产。
- **#723 冻结项**：`deploy/static/share-og-default.png` 必须随每次 web 部署播种到主机 `${DEPLOY_DIR}/share/` 且 `chmod 644`；增量与 legacy 两条路径都不得漏。本地 `deploy.yml` 曾落后于 master 而缺该逻辑，推前必须从 master blob 恢复并重放，否则会回退生产修复。

## Review Focus

| # | 隐含失败模式 | 合理预期 | 钉住它的测试 |
| --- | --- | --- | --- |
| 1 | 只把 `scp` 换成 `rsync` 却漏 `--checksum`，mtime 变化就全量重传 | 内容相同的大文件不进同步日志 | Task 1 S1 + 变异 M1 |
| 2 | 加了校验但用 `\|\| true` 或只在成功分支打印 | 篡改远端文件后 exit≠0、无成功标记 | Task 1 S4 + 变异 M2 |
| 3 | 忘了清旧 `assets`，远端堆历史 chunk | 同步后 `assets` 集合与本地一致 | Task 1 S3 + 变异 M3 |
| 4 | 回退开关是空壳，出事回不去 | legacy 路径交付物集合与增量路径相同 | Task 1 S5 + 变异 M4 |
| 5 | harness 没接线，「零传输 / 零失败」是假绿 | 远端执行器被调用、同步日志非空、清单行数吻合 | Task 1 S7 + 变异 M5 |
| 6 | 顺手引入 `--delete` 或 staging 切换，改变发布语义 | 源级门禁禁止 `--delete`；契约不变项逐条核 | Task 4 源级检查 |
| 7 | runner 无 rsync 直接 deployment 失败 | 自动降级 legacy 并打印原因 | Task 1 S6 |
| 8 | 改完 `deploy.yml` 但 CI 没挂契约，日后回归无人拦 | `spec-figures` job 必含该步骤 | Task 4 + Task 6 PR 文件清单 |

---

### Task 1: 写行为级 harness 并证明基线 RED

**Files:** `scripts/verify-web-upload.py`（新增）

- [ ] 用 `tempfile.TemporaryDirectory` 造三块：`local/`（本地 dist）、`remote/`（模拟 `/opt/lnkpi/web/dist`）、`tools/`（注入的 `remote_exec` / `copy` wrapper）。
- [ ] `local/` 内容：5 个「大文件」（各 256 KB 随机但固定字节）、`assets/` 下 2 个 hashed chunk、`index.html`、`auth/` 一个静态文件；`remote/` 预置同内容大文件但 **mtime 调早 1 小时且内容相同**、3 个旧 hashed chunk、以及一份内容不同的 `index.html`。
- [ ] `remote_exec` wrapper：把传入的远端命令在 `remote/` 根用 `bash -c` 执行，并把调用次数追加到 `tools/remote_exec.count`；`copy` wrapper：把源文件复制进 `tools/inbox/`（模拟 `/tmp`）。
- [ ] 实现 7 组场景函数，全部通过 `subprocess.run` 调用 `bash deploy/upload-web-dist.sh` 并传入环境变量：`LNKPI_WEB_DIST`、`LNKPI_WEB_RSYNC_DEST`、`LNKPI_WEB_REMOTE_EXEC`、`LNKPI_WEB_COPY`、`LNKPI_WEB_SYNC_LOG`。
- [ ] S1 读同步日志，断言大文件名对应行以 `.` 开头（仅 mtime 更新）且 `Number of files transferred` ≤ 3；S2 逐文件比对 sha；S3 断言旧 chunk 不存在且非 assets 历史文件存活；S4 用 `LNKPI_WEB_VERIFY_ONLY=1` + 篡改一个远端文件，断言 exit≠0；S5 用 `LNKPI_WEB_UPLOAD_LEGACY=1` 并断言 `copy.log` 里出现 tgz；S6 用 `LNKPI_WEB_RSYNC_BIN` 指向不存在的命令触发自动降级；S7 断言计数 > 0、日志非空、清单行数 = 本地文件数；S8 断言 #723 的 `share-og-default.png` 被播种到模拟 SHARE_DIR 且逐字节一致、权限 644。
- [ ] 源级类别化检查：`SS5` 断言脚本与 workflow 都保留 #723 播种说明与 `cp -f` / `chmod 644`。
- [ ] 源级类别化检查：读真实 `deploy/upload-web-dist.sh` 与 `.github/workflows/deploy.yml`，断言上传步骤不内联 `scp /tmp/lnkpi-web-dist.tgz`、脚本远端 rsync 带 `--checksum`、无 `--delete`、`sha256sum -c` 失败路径无 `|| true`。
- [ ] **跑一次证明 RED**：此时脚本还不存在，记录 exit 码与失败组号（预期 ≥ 4 组失败），保存 `/tmp/web-upload-red.log`。

### Task 2: 实现上传脚本，转 PASS

**Files:** `deploy/upload-web-dist.sh`（新增）

- [ ] 头部 `set -euo pipefail`；`sha256()` 兼容 `sha256sum` 与 macOS `shasum -a 256`。
- [ ] 缺省值：`DIST`、`REMOTE_DIST=${LNKPI_WEB_REMOTE_DIST:-/opt/lnkpi/web/dist}`、`REMOTE_DEPLOY_DIR`、`REMOTE_HOST`、`RSYNC_DEST`、`RSYNC_BIN=${LNKPI_WEB_RSYNC_BIN:-rsync}`、`REMOTE_EXEC`、`COPY_CMD`、`SIDECARS=${LNKPI_WEB_SIDECARS:-deploy}`、`WORK=${LNKPI_WEB_WORK:-/tmp}`、`INBOX=${LNKPI_WEB_INBOX:-/tmp}`、`SYNC_LOG`、`LEGACY`、`VERIFY_ONLY`；`SHA_BIN` 按本机能力选 `sha256sum` 或 `shasum -a 256`，远端校验时再独立探测一次。
- [ ] `run_remote()`：有注入的 `REMOTE_EXEC` 时按其执行，否则 `ssh deploy-cvm`；测试模式下注入命令在模拟远端目录执行。命令内路径用环境变量传入，避免引号嵌套。
- [ ] `make_manifest()`：在 `DIST` 内 `find . -type f` 排序后逐文件 sha256，写到 `tools/manifest` 临时文件；行数与文件数一致。
- [ ] `prepare_remote()`：`run_remote "rm -rf ${REMOTE_DIST}/assets"`（保留原语义，禁止 `--delete`）。
- [ ] `incremental_upload()`：`rsync -az --checksum --partial --timeout=60 --out-format='%n' "${DIST}/" "${RSYNC_DEST}" > "${SYNC_LOG}"`；若 `command -v rsync` 失败或 `LNKPI_WEB_UPLOAD_LEGACY=1`，转 `legacy_upload()`。
- [ ] `legacy_upload()`：`tar -czf /tmp/lnkpi-web-dist.tgz -C "${DIST}" .` → `copy` 到远端 inbox → `run_remote "tar -xzf … -C ${REMOTE_DIST}"`；输出打印降级原因。
- [ ] `upload_sidecars()`：把 `deploy/nginx.conf`、`deploy/deploy-web.sh`、manifest 复制到远端 inbox，再 `run_remote` 做 `cp` / `chmod +x`；这三步保持旧流程的落点。
- [ ] `verify_only()` 与 `verify_manifest()`：`run_remote "cd ${REMOTE_DIST} && sha256sum -c <manifest>"`；失败 `echo` 到 stderr 并 `exit 1`，**不得** `|| true`；成功打印 `MANIFEST_OK files=<n>`。
- [ ] `main()`：`VERIFY_ONLY=1` 时只跑校验（不传、不清 assets）；否则按 prepare → upload → sidecars → verify → cleanup 顺序；cleanup 只在校验成功后执行。
- [ ] 用 `[[ "${BASH_SOURCE[0]}" == "$0" ]] && main "$@"` 守卫，便于后续单函数复核，但 harness 一律走完整 `bash` 调用。
- [ ] 跑 `python3 scripts/verify-web-upload.py`，7 组全 PASS，保存 `/tmp/web-upload-pass.log`。

### Task 3: 变异测试（每条必须 RED）

**Files:** 临时改 `deploy/upload-web-dist.sh`，跑完恢复

- [ ] 用 Python 脚本逐条替换并调用 harness，记录 exit 与失败组：M1 删 `--checksum` → S1；M2 把 `sha256sum -c` 改成恒真 → S4；M3 删 `rm -rf …/assets` → S3；M4 删 legacy 分支 → S5；M5 让 `run_remote` 空转 → S7；M6 删 `cp -f ... share-og-default.png` → S8 + SS5。
- [ ] 每条变异先断言「源文件真的变了」，防伪变异；断言 exit≠0 且命中预期组。
- [ ] 恢复固定版，逐文件计算裸 blob sha 与固定版一致，再跑一次全 PASS。

### Task 4: workflow 与 package 接线

**Files:** `.github/workflows/deploy.yml`、`.github/workflows/ci.yml`、`package.json`

- [ ] `deploy.yml` 的 `Upload web dist and nginx config` step：把 `tar -czf` / `scp` / `ssh … tar -xzf` 三行内联块整体替换为 `bash deploy/upload-web-dist.sh`（保留 `set -euo pipefail` 与 `DEPLOY_DIR` 取值）。
- [ ] `deploy.yml` 该 step 增加 `env:` **只显式传一键回退开关** `LNKPI_WEB_UPLOAD_LEGACY: ${{ vars.LNKPI_WEB_UPLOAD_LEGACY || '0' }}`；其余路径全部走脚本缺省值（与生产现状一致），避免 workflow 与脚本两处维护同一组常量。
- [ ] `ci.yml` 的 `spec-figures` job 在 `Verify markdown links` 之后加 `- name: Verify web dist upload contract` / `run: pnpm verify-web-upload`。
- [ ] `package.json` 的 `scripts` 增加 `"verify-web-upload": "python3 scripts/verify-web-upload.py"`。
- [ ] 源级复核：Python 直读三个文件，确认没有 `--delete`、没有残留内联 `scp /tmp/lnkpi-web-dist.tgz`、`rsync` 参数齐全、CI step 存在。

### Task 5: 文档衔接与本地全量门禁

**Files:** F1 规格 §12、P0 报告 §6、本文 §13

- [ ] F1 规格 §12 第 1 条改为「已由 #2 独立刀承接，定量结论见该规格 §8；撤销 retry 方向」。
- [ ] P0 报告 §6 的 #777 结论补注「取消过早但只是运维规避；治理见 #2 规格」，并更新下一步排序。
- [ ] 跑 `pnpm verify-spec-figures --file <新规格>`、`pnpm verify-spec-figures`（全量）、`pnpm verify-links`、`pnpm verify-claims`。
- [ ] 跑 `pnpm verify-web-upload`、`vue-tsc -b`、`pnpm -r build`、全量 vitest（`--maxWorkers=1 --no-file-parallelism`）；记录结果。
- [ ] 本文 §13 填入实际校验结果。

### Task 6: 推 PR、CI 三必需、squash、合并后核验

- [ ] 推前：`gh api` 取 master HEAD 与全树，逐路径比对本次 9 个文件的裸 blob sha；差异文件先从 master 取 blob **落盘覆盖本地**再重放本刀改动，防止回退并行改动。**本刀实测**：`package.json` 缺 `pnpm.patchedDependencies` / `verify-thread-unify`，`deploy.yml` 缺 `deploy/static/**` 触发、disk-watchdog 安装与 #723 OG 播种，均已恢复后重放。
- [ ] 用 `gh api` Git-Data 链：POST blobs → POST trees（base_tree = master tree）→ POST commits（parent = master HEAD）→ POST refs 建分支 → POST pulls；PR 描述贴测量表、变异结果、回退开关用法。
- [ ] `gh pr checks` 等三必需全绿；若 `Verify spec figures` 因新契约失败，先修脚本再重推，不得跳过检查。
- [ ] squash 合并；合并后取新 master 全树，逐路径核对本次所有 blob sha 全等；删分支。
- [ ] `gh run list --workflow=deploy.yml` 确认自动部署 run 存在且未被 concurrency 静默取消；若挂审批闸门，按 `pending_deployments` + environment_ids 处理。

### Task 7: 生产真实发布复验与证据回写

- [ ] 等自动部署 run 完成，记录 `Upload web dist and nginx config` 步骤耗时（门槛 ≤ 8 min）与日志中的 `MANIFEST_OK files=<n>`。
- [ ] （**可选，本次未执行**）手工 `workflow_dispatch` 一次 `deploy_web_only=true` 做耗时方差对照。两条触发分支共用同一脚本与 env，不新增代码路径覆盖，且会与同组 `Build API on CVM` 排队并再动一次生产 nginx；决策与实测见 `docs/ops/2026-11-08-web-dist-upload-prod-verify.md` §5。
- [ ] `ssh deploy-cvm` 在 `/opt/lnkpi/web/dist` 内 `find . -type f -print0 | sort -z | xargs -0 sha256sum` 自洽性检查；`curl` 断言 `http://119.29.173.89:8888/`、`/api/health`、`index.html` 引用的 chunk 全 200。
- [ ] 用 P0 的 Chrome CDP 脚本做一次只读页面加载冒烟（可选，链路未变则不强求）。
- [ ] 结果写入 `docs/ops/2026-11-08-web-dist-upload-prod-verify.md` 并提独立文档 PR；`.workbuddy/memory/2026-11-08.md` 追加日志，`.workbuddy/memory/MEMORY.md` 更新 scp 结论。
- [ ] 不达标（超时 / 校验失败 / 502）⇒ revert 单个 squash commit 恢复旧链路，再复盘；不手动 scp 兜底、不 rerun 慢链路。
