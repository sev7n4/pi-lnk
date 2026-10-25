# 品牌锚图标落地 Implementation Plan（修订：品牌资产提取 + 双色徽标）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 从 lnk π 品牌 Logo 资产 `c80d7b56…transparent.png` 反相抠取**纯锚**（替换 `anchor-generate.png` / `anchor-locate.png` 内容，几何与品牌同源），并新增**双色徽标** `anchor-badge.png`（黑盘+白锚+外环+波浪，锚洞填白以适配暗底），供 `SlideToCreate` / `CanvasRefTargetIcon` 以 `<img>` 渲染。

**Architecture:** 复用现有 `currentColor` + `mask` 蒙版机制服务「纯锚」（几何在 alpha 通道）；新增 `anchor-badge.png` 以 `<img>` 服务「双色徽标」（固定颜色位图）。生成器 `scripts/gen-brand-anchor-icons.py` 从品牌资产反相抠取，一次产出三文件。

**Tech Stack:** Python 3（系统 runtime）、Pillow、numpy；纯锚由现有 Vue/CSS `mask` 消费，徽标由 `<img>` 消费。

**Spec:** `docs/design/2026-10-24-brand-anchor-icon-spec.md`（本计划逐条对应 spec，执行者两份都读）

## Global Constraints

- **纯锚尺寸精确**：`anchor-generate.png` = 94×106，`anchor-locate.png` = 93×93（spec §5.1）。
- **徽标锚洞为真实白、环-盘留白透明**（spec §5.2）。
- **不改 `SignatureHero` / `DockGenerateButton` / `AgentSideRail` 的纯锚引用**：保持 `mask` 不动；`home-profile-p3.guard.test.ts:147` 断言 `HERO_SRC` 含 `anchor-generate.png` 不受影响（spec §4）。
- **新增 `anchor-badge.png` + 改两处 `<img>`**：`SlideToCreate.vue`、`CanvasRefTargetIcon.vue` 从 `mask` 改为 `<img>`（spec §3）。
- **生成器可复现**：脚本与 PNG 一并提交（spec §6）。

## Review Focus

1. **纯锚连通/孔洞**：extract 取含画布中心的连通分量，需确认是中央锚而非波浪碎片——目检纯锚为完整锚（球头+横杆+双爪+长杆）。
2. **徽标锚洞填白正确**：锚洞应被填为白（暗底可见），但环-盘留白应保留透明（不填白）——目检白底/暗底 composite。
3. **`<img>` 替换 mask 后无残留**：两组件删除 `background: currentColor` 与 `mask` 行，改为 `object-fit: contain` 的 `<img>`。
4. **暗底消失**：徽标锚已填真实白，暗底不消失；纯锚仍靠 `currentColor`，需在暗底上下文确认 `currentColor` 为浅色。
5. **guard 测试静默红**：`home-profile-p3.guard.test.ts:147` 断言 `HERO_SRC` 含 `anchor-generate.png`；`SignatureHero` 未改，应仍绿。

---

### Task 1: 重写锚图标生成器（品牌资产提取 + 徽标）

**Files:**
- Modify: `scripts/gen-brand-anchor-icons.py`

**Interfaces:**
- Consumes: 品牌资产 `lnk-pi-logo_assets/c80d7b56…transparent.png`
- Produces: `extract_anchor_mask()`（纯锚蒙版）、`extract_badge_rgba()`（双色徽标）；CLI 写出三文件。

- [x] **Step 1: 写生成器脚本**（含 `extract_anchor_mask` / `extract_badge_rgba` / `to_square`，spec §2/§6）

- [x] **Step 2: 运行生成器，确认三文件写出、尺寸正确**

```bash
python3 scripts/gen-brand-anchor-icons.py
# → anchor-generate.png (94x106) [pure anchor mask]
# → anchor-locate.png  (93x93)  [pure anchor mask]
# → anchor-badge.png   (256x256)[two-color badge, anchor filled white]
```

- [x] **Step 3: 徽标双底可辨目检**（spec §5.5）—— composite 到白底/暗底确认锚可见

---

### Task 2: 替换纯锚 PNG + 新增徽标 PNG

**Files:**
- Modify: `apps/web/src/assets/icons/anchor-generate.png`、`anchor-locate.png`（内容替换，文件名不变）
- Create: `apps/web/src/assets/icons/anchor-badge.png`

- [x] **Step 1: 运行生成器覆盖/新增文件**

- [x] **Step 2: §5 门禁自检**（尺寸、white-fill、无低 alpha 雾、徽标锚洞白/留白透明）

---

### Task 3: 改两处消费位为 `<img>`（徽标）

**Files:**
- Modify: `apps/web/src/components/workflow/SlideToCreate.vue`
- Modify: `apps/web/src/components/shared/CanvasRefTargetIcon.vue`

**Interfaces:**
- Consumes: `anchor-badge.png`
- Produces: 两组件以 `<img :src="anchorBadge">` + `object-fit: contain` 渲染徽标

- [x] **Step 1: SlideToCreate** —— 引入 `anchorBadge`；模板 `<span class="lnk-slide__glyph">` → `<img ...>`；样式去 `background/mask`，加 `object-fit: contain`
- [x] **Step 2: CanvasRefTargetIcon** —— 同上（保留 `size` prop 控制盒尺寸）

---

### Task 4: 跑 guard 测试确认契约未破

**Files:**
- Test: `apps/web/src/pages/home-profile-p3.guard.test.ts`（只读）

- [x] **Step 1: 跑 home-profile-p3 guard 测试** —— 含 `anchor-generate.png` 用例 PASS（`SignatureHero` 未改）

---

### Task 5: 提交与 PR（按 branch-first 纪律）

**Branch:** `fix/brand-anchor-icons`（不在 master 提交）

- [x] **Step 1: 提交生成器 + 三 PNG + 两组件 + 文档**
- [ ] **Step 2: 推送并开 PR**（待代理恢复；https 502 时保留本地分支回报用户）

```bash
git push -u origin fix/brand-anchor-icons
gh pr create --title "fix(assets): 锚图标改品牌资产提取 + 双色徽标" \
  --body "纯锚从品牌 Logo 资产反相抠取（与品牌同源）；新增 anchor-badge.png 双色徽标并以 <img> 渲染 SlideToCreate / CanvasRefTargetIcon。SignatureHero/DockGenerateButton/AgentSideRail 纯锚保持 mask 不动，guard 断言零改动。"
```

---

## Self-Review

1. **Spec 覆盖**：§2 来源 → Task1 提取函数；§3 渲染契约 → Task3 `<img>`；§4 消费位点 → Task3 仅改徽标两位、纯锚位不动；§5 门禁 → Task2 自检；§6 可复现 → 生成器提交；§7 差异明确标注。
2. **占位符扫描**：无 TBD/TODO。
3. **类型一致性**：`anchorBadge` 经 `vite/client` 的 `*.png` 模块声明，`<img :src>` 类型安全。
4. **Review Focus**：#1 纯锚连通 → Task1 `extract_anchor_mask` 取中心分量 + 目检；#2 徽标填白 → `extract_badge_rgba` bbox∈disk 判定 + 双底目检；#3 `<img>` 替换 → Task3 删 mask 行；#4 暗底 → 徽标锚填白、纯锚 currentColor；#5 guard → Task4。五条均有落点。
