# P4 契约门禁化（#3 / PR #783）合并后验收记录（2026-11-08）

> 范围声明：本刀**零产品代码改动**，只新增测试、CI 脚本、CI 步骤与文档。因此本记录**不是新的生产行为冒烟**，只回答三件事：新门禁是否真的在 CI 上可失败地执行、因 `package.json` 触发的自动部署是否健康、以及规格里的三项边界决策有没有被悄悄绕过。生产业务链路的五层行为验收仍以 `docs/ops/2026-11-08-phase3-prod-smoke.md` 为准。

真值基线：master `b1190a2ae15751bdde53dd420c6ede5899b23742`（PR #783 squash）。
设计规格：`docs/superpowers/specs/2026-11-08-agent-siderail-p4-gates-design.md`；实施计划：`docs/superpowers/plans/2026-11-08-agent-siderail-p4-gates.md`。

## 1. 合并与合并树

| 项 | 结果 |
| --- | --- |
| PR #783 | `merge_method=squash` → `b1190a2a`，`mergeable_state=clean` |
| 合并树 | 10 个改动文件逐一与 PR 推送时的裸 blob sha 比对，**ALL_BLOBS_MATCH True** |
| 分支 | `phase4/agent-rail-gates-20261108` 已删除 |
| 合并瞬间健康 | 外网 `web=200` / `api=200` |

## 2. CI：新门禁在真实 runner 上执行

CI run `42470440899`（PR #783）：

| Check | 结论 | 耗时 |
| --- | --- | --- |
| Verify spec figures | pass | 31s |
| Build monorepo | pass | 6m39s |
| Build API Docker image | pass | 3m23s |
| prompt-registry 门禁 | pass | 21s |

`Verify spec figures` job 内的步骤逐一核对：`Verify spec figures (R1–R8)` success、`Verify web dist upload contract` success、**`Verify agent rail contract gates` success**。

⇒ 这一条排除了本刀最大的环境风险：verifier 只用 Python 标准库、只读仓库源文件，在本机 macOS 与 CI `ubuntu-latest` 行为一致；没有「本地绿 / CI 红」的假阴性。新步骤落在**已有** `spec-figures` job，未新建 job、未改 required check 集合。

本地门禁（合并前）：全 agent 组 **121 files / 1059 tests** 全绿、定向 ratchet 4/4、`vue-tsc -b` 0、`pnpm -r build` 0、`verify-spec-figures` 全量 199 篇 0 error + 5 篇逐篇 0/0、`verify-links` 0、`verify-claims` 7/7、`verify-agent-rail-gates` 11/11、上刀 `verify-web-upload` 13/13。判据链：接线前 **9/11 RED** → **11/11 PASS**，7 条变异（含 1 条注释伪变异对照）全部符合预期，恢复后 13 文件裸 blob sha 全等。

## 3. 自动部署：规格 §10 的显式决策得到验证

`deploy.yml` 的 `push.paths` 白名单含 `package.json`，本刀新增 CI script 会触发一次完整发布。规格 §10 的决策是**保留惯例、不绕过触发、不改 paths**，等待 run success 但不把部署结论当本刀门禁验收判据。

Deploy run `42471240576`：**整体 success**（10:23:37Z → 10:37:36Z）。

| Job | 结论 | 总耗时 | 主要步骤 |
| --- | --- | --- | --- |
| Detect changes | success | 0.13 min | — |
| Recover CVM only | skipped | — | — |
| Build API on CVM | success | 13.77 min | Sync source 5.32 / Wait for CVM build 6.80 |
| Deploy web to CVM | **success** | **2.68 min** | Build web 0.78 / **Upload 1.07** / Configure nginx 0.22 / Verify 0.15 |

**上传步骤第二次实测（#2 增量链路）**：

| 发布 | 上传步骤 | 说明 |
| --- | --- | --- |
| 旧全量 tar（run `42453812598`） | 15.05 min | 每次重传 16–19 MB，其中 65.3% 是不变的登录动画 mp4 |
| #2 首次增量（run `42465888033`） | 2.63 min | 首次启用 `rsync --checksum` + 清单校验 |
| **本次（run `42471240576`）** | **1.07 min** | 产物与上次几乎相同 ⇒ 差量近乎零传输 |

⇒ 增量链路效果稳定，且随产物变化量收敛。这印证 #2 的根因判断（耗时 ≈ 载荷 ÷ 吞吐）与「治理方向是减小载荷而非 retry/rerun」。

**部署日志三标记齐全**：`UPLOAD_MODE=incremental` → `MANIFEST_OK files=163` → `WEB_DIST_UPLOAD_OK`。

**远端自洽**：`/opt/lnkpi/web/dist` 163 文件 / 24M、`index.html` 3635 B（18:25 更新）、`/tmp/lnkpi-web-manifest.sha256` 163 行且 `sha256sum -c` exit 0、分享 OG 卡 200、本机 `web=200`。

## 4. 一次瞬时 502：记录并复查，不掩盖也不放大

首次远端核对时 `api=502`（本机与外网一致），同期 `Build API on CVM` job 仍在 `in_progress`（Sync source 5.32 min + Wait for CVM build 6.80 min），属**容器重建窗口**，与既有长期备忘「部署后 502 窗 ~30s」一致，但本次窗口随 API 构建拉长。

处理：连续三次间隔 20s 的探查 **web=200 / api=200（t1、t2、t3 全 200）**；整条 run 最终 success。`Build API on CVM` 与 web 部署是两个并行 job，web job 早已 success。⇒ **不宣告故障、不 rerun、不手动兜底**；后续验收脚本应在 API job 完成后再取健康快照，避免把部署窗口误判为回归。

## 5. 三项边界决策的落地确认

| 决策 | 落地证据 |
| --- | --- |
| CDP 五层冒烟脚本化拆 #4，不进本刀 | `compare master...` 的 10 文件清单中无任何 CDP / ops 脚本；`ci.yml` 只新增 1 个步骤且落在 `spec-figures`；P0 报告 §6 已显式修订原建议 |
| 「本地工作树 = master」不做 CI 门禁 | verifier 的 11 条 record 中无 git / 工作树判据；推前仍按纪律做 `gh api` 全树 blob 逐路径核对（10 文件全 SAME 或仅本刀差异） |
| 回环数只做回调型键代理指标 | `scripts/verify-agent-rail-gates.py` 的常量表锁 `MAX_CALLBACK_KEYS = 17`，全文无「5 条回环门禁」表述；规格 §3.3 / §11 与本报告措辞一致 |

冻结边界不变：`sendMessage` / `handleEvent` / `canvas_command` / `defineExpose` 11 项。本刀未改任何产品代码。

## 6. 结论与后续

- **#3 P4 门禁化闭环**：`defineExpose` 11 项冻结契约有单处类别化全覆盖 ratchet；注入依赖门禁机器可算、单调不增、接进已有 required check；ratchet 健康度与 CI 接线有自检；三项显式决策均未被绕过。
- **不追溯改写** P0 报告与 Phase 3 结项规格当时的验收结论；本记录只追加状态演进。
- **下一刀 #4**：CDP 五层冒烟参数化 ops runbook（生产地址 / 容器名 / 端口 / JWT 来源全部走环境变量，不挂 required check）。其余后续包：原子 staging 发布、上传字节数写入 `$GITHUB_STEP_SUMMARY`、P1 剩余刀、P2 状态写者收敛。
- 本报告为纯文档，`deploy.yml` 的 `push.paths` 不含 `docs/**` ⇒ 合并不触发部署。
