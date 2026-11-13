# Skill SOP · task-decomposition 实施计划

> spec：`2026-11-13-skill-sop-task-decomposition-design.md`。纯加目录 + 1 测试文件，零生产 TS 代码。

## Step 0 · 工作区

- [ ] 基于 master HEAD（c9ca3641 之后最新）快照建工作区，软链 node_modules（services/pi-runtime 与根）。

## Step 1 · SKILL.md 落档

- [ ] `skills/task-decomposition/SKILL.md`：frontmatter（name=目录名、`>` 折叠 description 含触发词族
      「多步/规划/方案/任务清单/一步步/先做啥」+「不适用」边界句）+ 正文按 spec §3 八条纪律，
      每条一句「为什么」，无任何无判据条文（自检：逐句过 §3 映射表）。
- [ ] 版本 0.1.0（对齐 html-craft 0.1.0 惯例）。

## Step 2 · wiring 守卫测试

- [ ] `src/skills/task-decomposition.wiring.test.ts`（spec §4 三段：发现+触发词 / description 完整性 /
      body 纪律关键句）。
- [ ] 跑 `node --import tsx --test src/skills/`：新测试绿 + 既有 loader/registry/html-craft 测试零破坏。

## Step 3 · 全量验证

- [ ] pi-runtime 全量 node --test 全绿（预期 1814+3 绿）。
- [ ] 核 `buildSkillIndexBlock` 长度增量：`/skills` 端点对比 description 总长（本地可起 dev 或直接算）。

## Step 4 · 推 PR（REST 链：blob→tree(base_tree 只传改动路径)→commit→ref→PR）

- [ ] 路径恰三：skills/task-decomposition/SKILL.md + wiring 测试 + spec（plan 可并入同 PR）。
- [ ] PR 正文回读长度核验；CI 全绿停合并前等授权。

## Step 5 · 合并-部署-取证-复测（授权后）

- [ ] squash 合并；合并树==CI head 树核验。
- [ ] **手工 dispatch runtime-deploy**（deploy.yml 不含 skills/ ⇒ 合并≠上线）；特征串 grep
      容器内 `/app/skills/task-decomposition/SKILL.md`（feature_grep 用正文独有句，feature_file 留空走默认
      或用 SKILL.md——按 workflow 参数定义适配）。
- [ ] `/skills` 端点核 10 目录；探针 session 验证 skills index 含新条目 + load_skill('task-decomposition')
      可加载（可不依赖 LLM：直接 curl load_schema 不可行，则留生产 §8.6 观测 + 下次探针顺带验证）。

## Step 6 · 记忆与路标回填

- [ ] daily log + MEMORY.md 长锚；路标只回填状态行（v1.3 冻结纪律）。
