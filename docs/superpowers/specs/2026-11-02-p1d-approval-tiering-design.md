# P1-D 审批分级（auto-approve 低风险）设计规格

> 2026-11-02 · P1 治本总纲 P1-5（分包 D）。前置输入：`2026-11-02-p1d-state-machine-input.md`（#671，代码实况状态机 + 幂等键五项）。上游背书：总纲 §行业不变量——Codex `auto_review` 用子 agent / 规则自动批准低风险动作，审批是 gate 而非必经打断。
> 自审章节见 §8。

## 1. 背景与问题

现状**每一次**生成（image / video / text / audio）都走 `proposeGeneration → pending_confirm 卡片 → 用户确认 → start-*`（agent-canvas-tools.controller.ts L1167/L1309/L1327/L1358/L1364）。文本生成这类零成本、零副作用的操作也要用户点一次确认——审批疲劳导致用户**机械性全点**，闸门形同虚设（总纲 §38 诊断）。

## 2. 目标 / 非目标

**目标**
- G1 按风险分级：低风险操作服务端自动批准直达 `generating`，高风险保持人工确认。
- G2 判定权归**服务端 SSOT**（agent/客户端不得自declare 低风险——防提权）。
- G3 可配置、可审计（打点），先保守放行、观测后再逐步扩大。

**非目标**
- 不做会话信任级 / 用户画像（v2）。
- 不动 `confirm-platform-fallback` / `confirm-composition`（运行时风险面，保持人工）。
- 不正名 cancel 状态（维持 `error('已取消')`；#671 §4.3 已评估改动成本，不做）。
- 不引入子 agent 审批（Codex 类比的轻量形态：静态规则先行）。

## 3. 设计

### 3.1 分级模型（裁决 #671 §4.1）

静态规则表，两维：**介质类型 × 覆盖性**。

| 介质 | 成本档 | v1 判定 |
|---|---|---|
| text | ≈0 | **auto-approve** |
| image | 低-中 | 人工（观测后再议） |
| audio | 中 | 人工 |
| video | 高 | 人工（永久，除非成本机制上线） |

覆盖性维度（生成落到已有节点覆盖内容 vs 新节点）v1 不参与判定——propose 链路当前总是落固定节点，无差分；规则表留 `coverage` 扩展位。

### 3.2 判定点与状态转移（裁决 #671 §4.2）

判定点在 **`proposeGeneration` 内部**（服务端，属性识别入参 mediaType + summary）。低风险路径：

```
draft ──propose(text, tier=auto)──▶ （跳过 pending_confirm，服务端 epoch+1）──▶ generating（start-text 同函数）
```

- **epoch 不变式**：auto 路径同样递增 `proposalEpoch`（「重提即纪元」保持），随后走与人工确认**完全相同**的 `startTextGeneration`（天然吃 P0-1 dedup + epoch 断言 + 锚点纪律）。
- 工具返回形态扩展：`{ nodeId, status: 'generating', generationRecordId, autoApproved: true, actions }`。agent 侧行为不变——B1 job 化后本就不等待，收到即结束回合，结算由 job + late-generation-notify 驱动。
- 高风险路径零改动（pending_confirm 卡片原样）。

### 3.3 决策幂等归属（裁决 #671 §4.4）

auto-approve **不**走 /answers（那是人工决策的 durable-part 裁决面）。auto 路径复用 start-* 全套既有幂等（dedup/epoch/锚点），**零新增幂等键**。重复 propose 同一节点：epoch 递增使旧 start 断言失败 → 走重提语义，正确。

### 3.4 配置面（G3）

`GENERATION_AUTO_APPROVE`（env，逗号分隔介质白名单，缺省 `text`；置空=全人工回滚开关）。服务端启动时解析，规则表按其过滤。

### 3.5 审计（裁决 #671 §4.5）

`logger.warn('approval_tier_bypassed', { sessionId, nodeId, mediaType, model, summary.model })`——`canvas_put_deprecated` 同形态（零阻塞）。两周观测后：量级异常或用户负反馈 → 收窄白名单。

## 4. 实施包（单 PR，预估 S）

| 文件 | 变更 |
|---|---|
| agent-canvas-tools.service.ts | proposeGeneration 判 tier + auto 分支（epoch+1 → startText 直调）；规则表 + env 解析 |
| agent-canvas-tools.controller.ts | 返回类型 + autoApproved |
| pi-runtime 工具侧 | propose 工具返回 union 扩展（透传，无逻辑） |
| web | `autoApproved` 卡片标记（可选，非阻塞——卡片本就不出现） |
| 测试 | tier 判定矩阵 / auto 路径 epoch+锚点断言 / env 回滚开关 / 高风险零回归 |

## 5. 验收

1. text propose 不出 pending_confirm 卡片，节点直达 generating，产物正常回填 completed。
2. image/video/audio 全链路零变化（人工确认原样）。
3. `GENERATION_AUTO_APPROVE=''` 部署 ⇒ 行为与 D 之前完全一致。
4. 打点可见 `approval_tier_bypassed` 且带 mediaType/model。

## 6. 风险

- **agent 对新返回形态的误读**：union 扩展而非替换，runtime 侧已有 `status` 分支处理（pending_confirm/generating 均为既有词表值）；测试覆盖。
- **未来 text 模型接入付费源**：规则表查表式，改表即收，无需改代码路径。
- **用户想看确认卡的习惯依赖**：白名单只含 text，影响面最小；打点给出真实影响量。

## 7. 规格偏差预留

无已知偏差（本规格先行于实现）。

## 8. 自审（交付前全盘检查）

- **充分性**：五问全部显式回答（§3.1/§3.2/§3.3/§3.5 + cancel 非目标）；状态机约束全部引用 #671 §2/§3，无新幂等键、无终态写点违规。
- **遗漏检查**：confirm-platform-fallback / composition 两确认面已划出范围（§2）；agent 返回兼容已覆盖（§3.2/§6）；回滚开关有（§3.4）。
- **与 P1 前序包的相容性**：B1 job 化（不等待）使 auto 路径无需新等待语义；B6 epoch 使重复 propose 天然安全；C0 守卫不受影响（守卫只看 pending_confirm 节点，auto 路径不产生 pending_confirm）。
