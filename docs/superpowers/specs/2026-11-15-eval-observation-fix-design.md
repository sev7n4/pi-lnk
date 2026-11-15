# Eval 观测修复刀（P0）：超时默认值 · 快照判据语义 · provider 透传

> 上位锚：C-1b spec §10 基线回填（`2026-11-13-c1b-fullset-multiturn-eval-design.md` §10）双探针实锤。
> 性质：eval 资产刀，**零生产代码路径**（生产入口零 ./eval 引用，C-1a 结论沿用）。
> 授权链：2026-11-15 用户裁决「授权 P0 修复」（磁盘项/agnes 429/真机走查另有拍板，不在本刀）。

## 1. 背景：双探针实锤的两大根因（2026-11-15 生产 pod 实测）

run-2（39 case 全量）的 18 条 BYOK fail 表面形态是「120s 超时零工具调用」。双探针把 timeout 放到 360s 后：

| 探针 | case | 结果 |
|---|---|---|
| A | c1a-decomp-01 | 211s、**25 次工具调用**（todo_write×3 → create_nodes_batch → set_node_text×7 → validate_canvas_layout 完整工作流）；fail 原因变为「清单条目数 0」 |
| B | c1b-struct-01 | 170s、**45 次工具调用**（spawn_subagent×2 + collect_subagent_result×6 + web_search 多代理全链）；fail 同签名 |

**根因 1（超时假象）**：deepseek-v4-flash 首工具调用延迟 >120s（思考型模型），120s 默认超时把完整工作流截断成「零调用」。18/18 条 fail 全部是截断假象（含 tool-discovery-001 / sidebar-ref-001 的 3×~128s——勘误 §10.1「2 条工具选择 miss」的旧口径）。

**根因 2（判据语义缺陷）**：`pickLatestPlanSnapshot` 取**最后一条** todo_write/propose_plan 快照，而模型遵守 SKILL「完成后清空」纪律收尾清空清单 ⇒ 终态空快照被判据读成「条目数 0 低于下限 2」「无 item 落 in_progress」。**判据与纪律互相打架**——模型行为健康，判据读错了快照。

## 2. 裁决

### D1 超时默认值：120s → 300s（全局默认，不按族配置）

- 证据：两探针实测 211s / 170s，均 < 300s；留 90s 余量。
- **不按 case 族配置**（YAGNI）：族配置需要先有各族时长分布数据，run-3 之后再议；`--timeout` CLI 已支持临时覆盖，探针期够用。
- 落点：`driver.ts` `options.timeoutMs ?? 120_000` → `?? DEFAULT_CASE_TIMEOUT_MS(300_000)`，常量具名导出（L0 可断言，不用真等 300s 才能测）。
- No-Go：不引入每 case 超时字段（case DSL 扩字段等有数据再说）。

### D2 快照判据语义：最后一条**非空**快照优先

- `pickLatestPlanSnapshot` 返回值改为 `lastNonEmpty ?? last`：
  - 存在非空快照 ⇒ 判最后一次**实质清单**（被终态清空调用覆盖不丢失）；
  - 全部为空 ⇒ 维持返回最后一条（「条目数 0 低于下限」照报——「调了拆解工具但没写条目」仍是真失败，且失败消息比「未触发拆解工具」更准确）；
  - 无任何拆解调用 ⇒ null（原语义，「未触发拆解工具」照报）。
- 判据注释必须写明：**「收尾清空 = 完成后清空纪律的合规信号，不是拆解缺失」**。
- `expectTodoStatus`（in_progress 存在性）消费同一 snap，随本修复自动对齐。
- No-Go：不改 minItems/maxItems 数值（C-1a 校准值）；不给「清空」单独造豁免分支（复杂度不值）。

### D3 provider 透传：runner 报告层补齐

- 背景：driver 三个返回点已带 `provider`（/sessions 响应透传，#880 起），但 runner 装配 per-case 结果只消费 `model`（C-1b §8.7 只要求 model 列）。BYOK 多渠道对比（deepseek-v4-flash vs deepseek-chat 等）需要 providerId 列做静默回落归因。
- 改动：`CaseResult.provider?: string` + 全部装配点与 `model` 同构透传（repeat 表决路径 providerSeen、单轮 2 处、多轮步循环 + 3 处返回点）。
- 报告展示随 model 列并列（runner 汇总行同步）。

## 3. 验收标准

1. pi-runtime 全量测试绿（干净树，含新增 L0 用例）；
2. **新增判据用例**：「写→修订→收尾清空」transcript ⇒ 判据读修订版非空快照（minItems 过）；「全空调用」⇒ 维持「条目数 0」失败；「无调用」⇒ 维持「未触发拆解工具」；
3. **变异自检**：把 D2 的 `items.length > 0` 守卫突变掉 ⇒ 新用例 RED；还原 ⇒ GREEN；
4. 双探针 case（c1a-decomp-01 / c1b-struct-01）默认 timeout 重跑 ⇒ 不再出现「120s 零调用」形态（生产复测，合并部署后）；
5. run-3 全量出新基线（后续刀）。

## 4. 诚实边界

- 300s 不是测出来的「充分值」，是 211s 实测 + 余量的保守值；若 run-3 出现 300s 截断，按族配置再立项。
- provider 列只透传不参与任何判据（纯报告元信息）。
- requiresConfirm 4 条（gen-claim-001/002、write-guard-002/003）**不在本刀**：用户拍板继续由 A-6 真机走查覆盖（自动确认 = 冒充 DockStudio 应答确认 API，有真实生成副作用且绕过被测的确认门本身，No-Go）。
- agnes 通道 8 条 429 不在本刀（用户侧实名认证解锁后补跑）。
