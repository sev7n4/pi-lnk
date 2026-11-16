# ADR-0016: 创作类 Skills 生态兼容采用「双通路归一 + 三档兼容 + 服务端确定性安装」，生态化从阶段四提前

| 字段 | 值 |
|---|---|
| 状态 | Accepted |
| 日期 | 2026-11-10 |
| 决策者 | 项目发起人（2026-11-10 目标澄清拍板） |

## 背景

2026-11-10 项目发起人明确产品目标：**pi-lnk 作为对话驱动画布创造的 Agent 平台，要兼容社区各类发布的创作类 skills 生态，提供「技能发现 + 加载技能」能力；用户通过「自定义加载」与「发现的技能」两条通路使用 skills 创作**，垂类至少覆盖短剧 / 音乐 / 图片 / HTML 动画网页。这不是"要不要做"的提案，而是方向拍板。

当时约束（均为可回查事实，完整证据链见配套规格 §3）：

1. **现状只有半个链路**。仓库 `skills/` 下 9 个 `SKILL.md` 由 Dockerfile `COPY` 进镜像，`SkillRegistry` 进程启动扫描一次；消费链路完整（index 常驻 systemPrompt + `load_skill` + `forceSkills` + `/skill`），但**没有**安装工具、市场端点、发现 UI、Skill 数据模型、热加载。前端 `DiscoverPane.vue` 的「技能」是 disabled 的「敬请期待」占位，`AGENT_SKILLS` 硬编码只有 1 项。
2. **社区供给侧已成熟，但形态不匹配**。`SKILL.md` 是 agentskills.io 开放标准（Codex / Cursor / Copilot / Gemini CLI 等采纳）；仅短剧垂类就有 83 个技能包（81 个标准 SKILL.md）、`zenstory-ai/drama-skills` 13 个 SKILL.md / 2.36 万安装 / MIT。但这些包的主流形态是**本地文件系统 + Python + ffmpeg/ffprobe + CLI + 外部模型 API**，把创作状态写进 `ep01/script.md`、`storyboard.md`；本平台是画布节点、无 shell、NetworkPolicy egress deny。⇒ 直接 drop-in 会「能加载、能触发、按它执行必然失败」。
3. **开放安装已被行业实证为高危供应链面**。Snyk ToxicSkills（3,984 个技能，13.4% 含 critical 缺陷、36% 含提示注入）、USENIX Security '26（98,380 个中 157 个恶意、73.2% 藏 shadow features）、Orca 的市场四原语（安装数可刷、扫描非确定、同名静默覆盖、盲批量更新）。而本平台 skill 正文「不走 Nest、不经 Gate」直入 systemPrompt，`SkillRegistry` 是按 name 的全局 Map、无 namespace / 无版本 / 无签名。
4. **CLI 与服务端多租户的信任边界不同**。Codex / WorkBuddy 是桌面/CLI 形态，技能落在用户自己的 `~/.claude/skills`，信任由用户本人承担；pi-lnk 是服务端多租户，技能正文进的是**共享 runtime 进程与 systemPrompt**，一个恶意技能影响所有会话与平台密钥。
5. **既有路线图把生态化排在阶段四**。`2026-09-25-workbuddy-alignment.md` §6 把「生态化（skill/连接器开放创建与分享）+ 企业权限/审计/租户隔离」列为阶段四；`2026-09-10-wave-a-delivery-program-design.md` §2.2 明确不做「`/技能名` 斜杠技能市场、多 Skill 并行编排」。按 ADR README 的规则，Accepted 的历史判断不删不改，但**方向变更需要新 ADR 明确记录为什么提前**。

6. **发起人当晚追加「行为北极星」**（2026-11-10）：要求以 WorkBuddy 当前对 skills 的设计为复刻对象。第三轮只读核查（完整证据见配套规格 §3.9 的 F38–F55）确认对方面已具备：技能页两区与四维排序、五条获取通路（市场一键装 / 对话安装 / 上传技能包 / AI 创建 / 查找并安装）、上传包分级安全检测、安装与管理工具权限收窄（`search_and_install_skills` 与 `skill_management` 均**无 uninstall**、无自主 enable）、启用/关闭**不改 `SKILL.md` 原文件**且新会话才完全生效、卸载 ≠ 关闭且支持批量、更新/回滚与用户改写保护、显式（点选 / 斜杠 / 点名）与隐式（description 语义匹配）双调用、`disableModelInvocation` / `userInvocable` / `allowed-tools` 触发控制，以及 `.skill-list-cache.json` 的文件监听 + 签名失效重扫。**这些用户可感知契约必须复刻；其本地目录安装、`scripts/` 可执行、以用户本人身份执行系统命令属本地单用户信任模型（F35/F55），不得照搬。**

另有一条既有判断需要同时纠正：`2026-10-04-vendor-ext-review-registertool-pion.md:86` 写「若用户中途装/卸 skill，工具集无法更新——只能重建会话」，并据此把 `setTools` / `setActiveTools` 登记为待办（`:101-102`）。在**纯提示词 skill** 模型下这不成立：skill 只贡献一个 `load_skill` 工具，工具集与安装态无关；动态增删工具只在 roadmap 主线 B「技能包化 = activeToolNames 打包」落地后才是硬依赖。

## 考虑过的方案

| 方案 | 优点 | 缺点 | 为什么没选 |
|---|---|---|---|
| **A. 照搬 CLI 形态：agent 自主 clone / 解压到 `skills/` 目录** | 交互最像 Codex/WorkBuddy；实现看似最短 | 服务端共享目录 ⇒ 跨用户污染；镜像烘焙 + 启动扫描一次 ⇒ 装完要重建镜像/重启；egress deny 与联网拉取冲突；agent 执行 SKILL.md「前置步骤」正是 2026 年恶意技能战役的主感染向量；无签名/无回滚 | ❌ 信任边界与部署形态根本不兼容 |
| **B. 只做平台自营精选技能，不兼容社区生态** | 风险最低、治理最轻 | 与发起人 11-10 拍板的产品目标直接冲突；社区创作类供给（尤其短剧）已规模化，放弃等于放弃长尾 | ❌ 目标不允许 |
| **C. 把「第三方 SKILL.md 免改码 drop-in 自然触发」当兼容完成** | 复用现有 loader，零新增组件 | 验收线只验「加载 + 触发」，未验产出；本仓 skill 深度绑定私有工具名（`run_audio_generation` / `propose_generation` / `upsert_media_node` / `tool_search`）与 HITL Gate 语义 ⇒ 第三方包能触发却干不了活；`2026-09-24` 验收线（`:91`）正是这个漏洞 | ❌ 是伪兼容，会把未闭环项误判为完成 |
| **D. 双通路归一 + 三档兼容 + 服务端确定性安装（选中）** | 兼容范围可度量、可降级而非静默失败；两条用户通路共用一套实现；不改镜像不热重载；风险在控制面收敛 | 需新建控制面、虚拟工作区、能力适配器；社区 skill 覆盖率不会 100%；审核/合规是长期运营成本；需显式修订 6 份既有文档 | ✅ |

> **11-10 晚间补充**：以 WorkBuddy 为**行为北极星**（背景第 6 条）是 D 方案的约束强化，不是新增备选方案。A 的「照搬 CLI 形态」仍被否决；被采纳的是对方的**用户可感知契约**，由决定第 8 条与规格 §4.7 落到逐能力裁决，并由 §4.7 的 Won't 列明确划出不可照搬的信任模型。

## 决定

1. **生态化从阶段四提前为主线议题**，但采用「策展式发现 + 受控导入」而非「开放 UGC 市场」作为起步形态。历史文档不追溯改写，由配套规格 §3.7 逐份显式声明「修订 / 推翻」。
2. **兼容是分级契约，不是布尔值**：`C0 知识`（方法论/规范直入上下文）、`C1 产物`（文件路径约定 → 虚拟工作区 → 画布文本节点 / UserAsset）、`C2 执行`（脚本/CLI/外部 API → 能力适配器 → `propose_generation` 确认门 + `run_*` + `ModelCatalogEntry`）、`C3 拒绝`。发现页展示**兼容性评分**，不静默降级。
3. **双通路归一**：「技能发现」与「自定义加载」只是 `sourceType` / `trustLevel` 不同，统一落到 `UserInstalledSkill`，共享解析 → 校验 → 兼容评估 → 内容寻址存储 → 注入 → 回滚。禁止两套实现。
4. **加载三粒度**：订阅启用（长期 index）/ 会话内临时加载 / 单轮显式调用（`forceSkills`）。技能正文按 `contentHash` 存 Nest 控制面，**不写 runtime 容器文件系统**；单轮注入复用 `/prompt` 的 `skillBodies` 扩展点，实现「同一会话下一轮即生效」。
5. **安装是服务端确定性流程**：agent 只负责检索与发起申请，绝不执行 `SKILL.md` 里的前置步骤；所有安装/生成动作收敛到**单一确认表面**（延续 ADR-0011），社区 skill 自带的 confirmation gate 语义与本平台 HITL Gate 对齐。
6. **P0 安全硬约束**（不可协商）：只解析 `SKILL.md`、README 只作展示文本不进 prompt；禁 `scripts/` 执行与前置命令；出网白名单只给 Nest 控制面、runtime 保持 deny；`<publisher>/<skill>` 命名空间 + `contentHash` 钉住 + 不可变版本；注入扫描与内容合规；未审技能默认禁用且需显式确认。
7. **不承诺 `setTools` 依赖**：M0/M1 在纯提示词 skill 模型下完成；`setTools` / `setActiveTools` 从「skill 热更新的前置待办」降级为「主线 B 技能包化后的可选项」，上文纠正的判断写入规格 §3.5。
8. **以 WorkBuddy 为产品行为北极星，复刻契约而非实现**（11-10 当晚补充）：由配套规格 §4.7 逐能力裁决 `Must` / `Should` / `Won't`，图 4 为生命周期唯一结构基准。M1 收口前，六面（发现、自定义安装、启用/关闭、卸载、显式、隐式）加上版本回滚与免重启生效的 Must 项必须各有 §10 行为级判据与可转红负例；`Won't` 四类（本地目录与脚本执行、未审技能显式绕过、runtime 直连社区、热度当信任）是**永久偏离**，需负例防回潮并在产品文档如实说明。**两个北极星不许互相替代**：行为对齐在 M1，四类真实社区技能的端到端画布产出在 M2；M1 全绿不得对外表述为「已复刻 WorkBuddy 技能系统」或「生态兼容完成」。

## 后果

**正面**

- 双通路共用一条流水线，避免「发现的能用、自己传的不能用」的实现分叉；per-user 隔离与 hash 回滚天然具备。
- 兼容性分级把「生态兼容」从口号变成可验收、可量化、可解释的产品语义；M0/M1 不联网、不做 UGC、不改镜像即可交付真实用户价值。
- 复用既有宿主（SKILL.md loader、`forceSkills`、`UserWorkflowRecipe` 隔离范式、上传通道、admin 目录 CRUD、DiscoverPane 占位、works fork 范式），执行面只需微创扩展。
- 安全责任收敛到 Nest 控制面单一入口，审计/回滚/合规有落点。

**负面 / 代价** ❗

- 需新建三块此前不存在的东西：`SkillCatalog` + `UserInstalledSkill` 控制面、**虚拟工作区**、**能力适配器与能力词表**。这不是「接个市场」的工作量。
- 内置 9 个 skill 需按新契约重写为 golden（含 capability 声明、垂类标签、兼容档），且改 `skills/**` 按 `AGENTS.md` 要手工 dispatch `runtime-deploy`，发布链变长。
- 社区 skill 覆盖率不会到 100%：依赖 ffmpeg / 本地 CLI / 出网执行的流水线只能以 C0+C1 降级使用，部分必须明确拒绝，需在 UI 诚实说明。
- 规范-实现漂移债要一次性偿还：至少 6 份既有文档的阶段判断/不做项需显式修订或推翻（清单见规格 §3.7），`pnpm verify-claims` 与 `verify-links` 需回归。
- prompt index 随订阅技能数增长，需设条数上限与配额；多技能并行编排的语义匹配噪声是已知未解问题。
- 长期运营成本：审核、签名/来源治理、许可证与生成内容合规、恶意样本回归集，都不是一次性工程。
- **北极星对齐显著扩大 M1 范围**（11-10 追加）：从「装得上 + 注得进」扩到完整生命周期（启停不改正文、软删除卸载与批量、二次确认、触发控制字段、索引缓存签名、目录排序与语义检索的名称/确认约束），新增 2 条 M0 判据、5 条 M1 判据与 6 条可转红负例；还必须长期维护 `Won't` 偏离清单，否则「没有复刻本地目录/脚本执行」会被误读为未达标。

**将来要注意**

- 若 vendor `pi` 后续在 `pi-agent-core` 提供原生 skill registry / 沙箱 / 签名机制，按 ADR-0009「先查 vendor 能力面、禁自研等价物」优先对齐，而非继续维护自建等价物。
- 若产品形态转向本地/桌面运行（信任边界回到用户本机），应重新审视「服务端确定性安装」是否仍是最优，可考虑回归 CLI 式目录安装。
- 若出现真实合规要求或第三方技能事故，应把「开放 UGC 发布」进一步后置，并把兼容性评分从展示项升级为安装门禁。
- 若社区标准新增强制签名 / 权限清单 / 沙箱规范，本 ADR 的 P0 硬约束应随之升级，并另写新 ADR。

## 关联

- [ADR-0001](./0001-vendor-pi-as-kernel.md)（vendor pi 作内核）、[ADR-0009](./0009-vendor-capability-first.md)（先查 vendor 能力面）
- [ADR-0011](./0011-propose-confirm-single-surface.md)（提议确认单一表面）——本决策第 5 条直接延续
- [ADR-0003](./0003-prompt-registry-as-single-source.md)（提示词走注册表资产）——`SkillPackage` 契约沿用「文件即配置 + 内容完整性校验」精神
- 设计规格：`docs/superpowers/specs/2026-11-10-creative-skills-ecosystem-discovery-loading-design.md`（13 节，含完整事实依据、4 张图、M0/M1 行为级判据与可转红负例）
- 北极星证据与裁决：配套规格 §3.9（F38–F55 WorkBuddy 实现解剖）、§4.7（Must/Should/Won't 逐能力映射）、图 4（生命周期与双调用通路）、§10 的 M0-A6/A7 与 M1-A7–A11
- 显式修订/推翻的既有文档清单：见配套规格 §3.7
- 编号说明：本 ADR 编为 `0016`，承接 `0015-unified-single-conversation-identity.md`；`0012` 仍在另一分支待合入（见 `docs/adr/README.md` 既有编号说明），合入时按实际顺序重编号或一并补入索引。

---

## 修订记录

### R1 · 2026-11-16 · 执行面改道：吃满上游原语，删除自建等价物

| 字段 | 值 |
|---|---|
| 状态 | **Accepted 保留**；本记录**修订「决定」第 4 / 7 条，新增第 9 / 10 条** |
| 触发 | 本 ADR「将来要注意」第 1 条（vendor 提供原生能力时按 ADR-0009 优先对齐）+ 发起人 2026-11-16 指令：「先用干净树跑一次 `setResources → lane.skill() → systemPrompt 装配` 的真实验证，再动规格」 |
| 历史正文 | **不追溯改写**（ADR-0008）。本节即修订记录，上方「背景 / 考虑过的方案 / 决定 / 后果 / 关联」保持原样 |
| 配套 | `docs/superpowers/specs/2026-11-16-creative-skills-ecosystem-discovery-loading-design-v2.md`（13 章 + 附录 A 探针全文 / B 实跑 stdout / C 原语速查） |
| 本轮三项交付落点 | ① **「上游原语清单」事实基座** = v2 §3.1（U-1…U-11）+ 本记录「新事实」第 2 条 + v2 附录 C 速查；② **M0 可达性探针判据** = v2 §10.1（M0-P1–P11）/ §10.2（可转红负例 M0-N1–N10）/ §10.3 变异自检实跑 + 附录 A 探针全文 + 附录 B stdout；③ **逐节差异表** = v2 §0.2（v1 13 节逐条处置）。本记录下方的「对『决定』各条的处置」表是 ADR 层的对应物 |

#### 新事实（可回查）

1. **v1 规格与本 ADR 在 true master `01c5ef104384e47ebcfbec6ca2fe0b0b317652b1` 上均 404**（`gh api .../contents/<path>?ref=01c5ef10`）⇒ 从未合入，只是本地草稿。因此本轮不是改历史正文，而是**新落 v2 稿 + 本 ADR 追加修订记录**；v1 §3.7 对历史文档的处置清单不继承。
2. **上游原语已原生具备**：pi-runtime 已依赖的 `@earendil-works/pi-agent-core@0.99.2`（带生产 `patch_hash=chjyb3jtnudd5ho3imavxe5pae`）导出 `Skill{content 内联}`、`AgentHarnessResources.skills`、`setResources/getResources`、`lane.skill()` + `UnknownSkill`、`formatSkillsForSystemPrompt()`、`formatSkillInvocation()`、`loadSkills(ExecutionEnv)`（`yaml@2.9.0`）、`disableModelInvocation`。清单与精确锚点见 v2 §3.1（U-1…U-11）。**零新增依赖、零 patch vendor、零引 coding-agent**。
3. **M0 可达性探针实证**：true master 干净 tarball 树 + `pnpm install --offline`（229 包全离线复用、实体 `node_modules`）+ 真 `AgentHarness.create`（不 mock、不 import vendor 源码）⇒ **11/11 GREEN**；关键变异 **4/4 RED**（逐条 `module_fail=False`，恢复后基线 `pass=11 fail=0`）。完整 stdout 见 v2 附录 B。
4. ⭐ **`setResources` 不落盘**（U-11 实测 `RESUME_RESOURCES_PERSISTED=false count=0`）：它是 harness 级内存 config，resume / fork / 进程重启后 `getResources().skills` 为空 ⇒ 必须由宿主重新注入。这是本轮最重要的新约束。
5. 生产 `AgentHarness.create` options **仍无 `resources`**（`session-manager.ts:1438`）；`systemPrompt` 是每轮求值函数；`/prompt` body 无 `skillBodies` / `skillIndex`（V-5 / V-7）⇒ **接线是后续工作，本轮零产品代码改动**。
6. 诚实边界：`resources.skills` 只被 `lane.skill()` 显式调用消费，index **不会自动**进 systemPrompt（`runtime/drive/generation.ts:62` 直通宿主 prompt）⇒ 宿主装配层仍须显式调 `formatSkillsForSystemPrompt()`。

#### 对「决定」各条的处置

| 条 | 原决定 | 处置 |
|---|---|---|
| 1 | 生态化从阶段四提前 | **保留** |
| 2 | C0/C1/C2/C3 兼容分级与兼容评分 | **保留** |
| 3 | 双通路归一到 `UserInstalledSkill` | **保留** |
| 4 | 加载三粒度 +「单轮注入复用 `/prompt` 的 `skillBodies` 扩展点」 | **推翻执行面**：`skillBodies` / `skillIndex` / `skillIndexSignature` 在生产与 true master 均不存在，是 v1 自造设计，不是既有扩展点。改为「`Skill[]` 内联正文 → `AgentHarness.create({resources})` / `setResources` 热更新 → 上游 formatter 装配 index → `lane.skill()` 显式调用」。**「正文不写 runtime 容器文件系统」的结论保留且更强**（正文在 config 里，连 HTTP body 都不经） |
| 5 | 服务端确定性安装 + 单一确认表面 | **保留** |
| 6 | P0 安全七条硬约束 | **保留**；其中「多行 `description` 必须正确解析（修复 F3）」一句删除 —— 上游 `yaml@2.9.0` 与现有 `loader.ts` 均已支持块标量 |
| 7 | 「不承诺 `setTools` 依赖」+ 背景里对 `2026-10-04` 文档的「纠正」 | **撤回该纠正**：B-1 已消费 `setActiveTools`；真正解决「装卸不必重建会话」的是 `setResources` config 热更新（U-4/U-6），不是「工具集与安装态无关」。`setActiveTools` 不再是「不做项」 |
| 8 | WorkBuddy 行为北极星、Must/Should/Won't、图 4、两个北极星不互替 | **保留，用户可感知契约逐字不变**；仅 P1/P10/P11/P12/P14 的实现措辞替换为上游原语 |

#### 新增决定

9. **执行面必须吃满上游原语、零自研等价物**（ADR-0009）：禁止在 pi-runtime 内自建 skill registry、index 行格式、索引缓存签名、frontmatter parser、`skillBodies` 式正文传输、未知名 fail-soft 白名单；`UnknownSkill` 判别统一用 `error._tag`（其 `.name` 承载的是技能名，U-8）；宿主必须显式调 `formatSkillsForSystemPrompt()`；上游升级（含 `patch_hash` 变化）必重跑 M0 探针。判据见 v2 §4.8 与 §10。
10. **`resources` 不落盘 ⇒ 每次 `AgentHarness.create` 必须显式注入**：新建 / 磁盘 resume / fork / 重启四条生命周期路径共用同一个 `buildSkillResources()` 注入点；`setResources` 只负责同一 harness 生命周期内的启用 / 关闭 / 回滚即时生效。见 v2 §7.3 与图 2。

#### 背景 / 后果勘误

- 「9 个 `SKILL.md`」→ 生产 **11 个**（新增 `research-delegate` / `task-decomposition`）；但 v2 不再以镜像内个数为判据（技能来自 DB）。
- 「`loader.ts` 多行 `description` 解析能力有限」→ **不成立**（已支持 `>` / `|` 块标量与 chomping）；「修复 F3」工作项删除。
- 「4MB `bodyLimit` 约束 `skillBodies`」→ **伪问题**；正文体积上限并入 `verifyImport`，理由改为 DB 行大小与上下文预算。
- 「需新建虚拟工作区 / 能力适配器 / 能力词表」→ **保留**（上游只解决加载与调用，不解决 C1/C2 兼容与产出）。
- **负面代价净变化**：删除 `parseSkillPackage` / `buildUserSkillIndex` / `computeIndexSignature` / `resolveSkillBodies` / 4MB 约束 / 白名单 fail-soft 六项工作量；新增「resume/fork 重注入纪律」与「上游升级必跑探针」两项长期运营成本。

#### 不闭环声明

M0 探针 GREEN **只证明路通**，不等于 M0 宿主接线完成，不等于 M1 控制面 / 双通路 / 生命周期已实现，更不等于 M2 四类真实社区 skill 的产出北极星。本轮 **零产品代码改动、零合并、零部署、零生产复测**；沿用 v1 的「不宣告 `ALL_PASS`」纪律。
