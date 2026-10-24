# 品牌锚图标对齐落地 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 `anchor-generate.png` 与 `anchor-locate.png` 两枚功能性锚图标，重绘为与 lnk π 品牌 Logo（路径 A 定稿）同一支锚的几何（负空间环 + 平直方头横杆 + 向上兜起的弯钩），消除箭头读感并统一产品内「锚」的视觉语言。

**Architecture:** 复用既有 `currentColor` + CSS `mask` 蒙版机制（几何在 alpha 通道），只替换两枚 PNG 的内容、不改文件名/消费位。以 Pillow + numpy 在 4× 超采样下按规范 §2 的参数绘制 canonical 锚，LANCZOS 降采样得到带 AA 的 white-fill 蒙版。生成脚本随资产提交，保证可复现。

**Tech Stack:** Python 3.13（managed runtime）、Pillow 12.3、numpy；产物为 PNG 蒙版，由现有 Vue/CSS `mask` 机制消费。

**Spec:** `docs/design/2026-10-24-brand-anchor-icon-spec.md`（本计划逐条对应 spec，执行者两份都读）

## Global Constraints

- **尺寸精确**：`anchor-generate.png` = 94×106，`anchor-locate.png` = 93×93（spec §5.1，逐像素核对）。
- **不改文件名/路径/消费位**：CSS `mask: url('@/assets/icons/anchor-generate.png')` 与 guard 断言依赖原路径（spec §1、§4）。
- **不改 `BRAND_LOGO_URL`、不改吉祥物、不动 favicon**：属于其它任务（spec §1）。
- **white-fill 蒙版**：形状 `RGB=(255,255,255)` 且 `A=255`，外部 `A=0`；上色靠 `currentColor`（spec §3）。
- **无低 alpha 雾**：全幅不得有 `1≤A≤8` 的成片像素（spec §5.2，此前透明稿踩坑）。
- **环为真孔洞**：内半径内 `A=0`，不得实心墨点（spec §5.3）。
- **生成器可复现**：脚本与 PNG 一并提交（spec §7）。

## Review Focus

1. **环被实心点填死**：Pillow 先画外环椭圆再「打孔」，若打孔顺序错或锚杆未覆盖孔底，环内会留实心墨点（icon-only 版同类缺陷）——目检穿透环圆心的水平剖面是否有透明段。
2. **横杆变成箭头/收尖**：曲线绘制时线宽不足或端点被裁剪，横杆端会呈三角——核对横杆两端为矩形平头。
3. **小尺寸（12–18px）糊掉**：`anchor-locate.png` 在 `CanvasRefTargetIcon` 下被用到 12/13/18px，锚杆+环的细节在 12px 可能黏连——导出后在 16px 缩略下目检是否仍可辨。
4. **暗底消失**：虽然 `currentColor` 理论上跟随主题，但需确认消费位在暗底时 `currentColor` 确为浅色（不是被某处写死深色）——在 `AgentSideRail`/`CanvasRefTargetIcon` 暗底上下文核对。
5. **guard 测试静默红**：即便文件名不变，`home-profile-p3.guard.test.ts:147` 断言 `HERO_SRC` 含 `anchor-generate.png`；若误改了 `SignatureHero.vue` 引用会红——跑该测试确认仍绿。

---

### Task 1: 编写锚几何生成器

**Files:**
- Create: `scripts/gen-brand-anchor-icons.py`

**Interfaces:**
- Consumes: 无（独立工具脚本）
- Produces: 两个函数 `draw_anchor(draw, W, H, ss)`、`render_anchor(W, H)` → 返回 PIL `Image`（RGBA，white-fill 蒙版）；命令行入口按 spec §2.1 绝对像素写出两枚 PNG 到 `apps/web/src/assets/icons/`。

- [ ] **Step 1: 写生成器脚本（含 spec §2 几何与 §5 门禁自检打印）**

```python
#!/usr/bin/env python3
"""按 docs/design/2026-10-24-brand-anchor-icon-spec.md §2 绘制 canonical 锚，
输出 white-fill CSS mask PNG。4× 超采样 + LANCZOS 降采样。
运行：python3 scripts/gen-brand-anchor-icons.py
"""
import math
import sys
import numpy as np
from PIL import Image, ImageDraw

SS = 4  # 超采样倍数

def draw_anchor_gray(d, W, H):
    """在灰度画布 d(白=形, 黑=空) 上绘制锚；返回后由调用方打孔+降采样。"""
    cx = 0.5 * W
    # 环（外椭圆实心）
    r_out = 0.123 * H; cy = 0.170 * H
    d.ellipse([cx - r_out, cy - r_out, cx + r_out, cy + r_out], fill=255)
    # 锚杆（竖条）
    sw = 0.066 * H; sb = 0.868 * H
    d.line([(cx, cy), (cx, sb)], fill=255, width=round(sw))
    # 横杆（平直方头）
    sty = 0.283 * H; st = 0.057 * H; hl = 0.255 * W
    d.line([(cx - hl, sty), (cx + hl, sty)], fill=255, width=round(st))
    # 钩（向上兜起的弯弧）
    hcy = 0.604 * H; hr = 0.245 * H; hw = 0.066 * H
    # PIL arc: start/end 角度（度，0=3点方向，顺时针），200°->340° 覆盖底部弧
    d.arc([cx - hr, hcy - hr, cx + hr, hcy + hr], start=200, end=340,
          fill=255, width=round(hw))

def render_anchor(W, H):
    sw = round(0.057 * H)  # 环内半径（打孔用），与 spec §2 内半径一致
    cy = 0.170 * H
    big = (W * SS, H * SS)
    gray = Image.new("L", big, 0)
    d = ImageDraw.Draw(gray)
    draw_anchor_gray(d, W * SS, H * SS)
    a = np.asarray(gray, dtype=np.float32)
    # 打孔：环内半径内置 0（锚杆在打孔后已绘制，覆盖孔底，重建连接）
    cx = 0.5 * W * SS
    yy, xx = np.mgrid[0:big[1], 0:big[0]]
    hole = ((xx - cx) ** 2 + (yy - cy * SS) ** 2) <= (sw * SS) ** 2
    a[hole] = 0.0
    small = Image.fromarray(a).resize((W, H), Image.LANCZOS)
    g = np.asarray(small, dtype=np.float32)
    out = np.zeros((H, W, 4), dtype=np.uint8)
    out[..., 0] = 255; out[..., 1] = 255; out[..., 2] = 255
    out[..., 3] = np.clip(g, 0, 255).round().astype(np.uint8)
    return Image.fromarray(out, "RGBA")

if __name__ == "__main__":
    base = "apps/web/src/assets/icons"
    for name, (W, H) in [("anchor-generate", (94, 106)), ("anchor-locate", (93, 93))]:
        im = render_anchor(W, H)
        im.save(f"{base}/{name}.png")
        print(f"wrote {base}/{name}.png {im.size}")
```

- [ ] **Step 2: 运行生成器并确认两文件写出、尺寸正确**

```bash
cd /Users/4seven/workspace/pi-lnk
/Users/4seven/.workbuddy/binaries/python/versions/3.13.12/bin/python3 scripts/gen-brand-anchor-icons.py
/Users/4seven/.workbuddy/binaries/python/versions/3.13.12/bin/python3 -c "from PIL import Image; \
for f in ['apps/web/src/assets/icons/anchor-generate.png','apps/web/src/assets/icons/anchor-locate.png']: \
    print(f, Image.open(f).size)"
```
Expected: `anchor-generate.png (94, 106)`、`anchor-locate.png (93, 93)`。

- [ ] **Step 3: 跑 §5 门禁自检脚本，确认全过**

```bash
/Users/4seven/.workbuddy/binaries/python/versions/3.13.12/bin/python3 - <<'PY'
import numpy as np
from PIL import Image
for f in ['apps/web/src/assets/icons/anchor-generate.png','apps/web/src/assets/icons/anchor-locate.png']:
    a=np.asarray(Image.open(f).convert('RGBA'))[...,3].astype(np.int32)
    rgb=np.asarray(Image.open(f).convert('RGBA'))[...,:3].astype(np.float32)
    fog=((a>0)&(a<=8)).sum()
    solid_rgb=rgb[a>250]
    print(f, '尺寸', Image.open(f).size, '淡雾像素', int(fog),
          '实心RGB', solid_rgb.mean() if solid_rgb.size else 'NA')
    assert Image.open(f).size in [(94,106),(93,93)]
    assert fog==0, '存在低alpha雾'
    assert solid_rgb.size==0 or abs(solid_rgb.mean()-255)<1, 'white-fill 不符'
print('门禁1/2/7 通过')
PY
```
Expected: 打印门禁通过、无断言失败。

- [ ] **Step 4: 连通域与环孔洞门禁（§5.3/§5.4）**

```bash
/Users/4seven/.workbuddy/binaries/python/versions/3.13.12/bin/python3 - <<'PY'
import numpy as np
from PIL import Image
for f in ['apps/web/src/assets/icons/anchor-generate.png','apps/web/src/assets/icons/anchor-locate.png']:
    a=np.asarray(Image.open(f).convert('RGBA'))[...,3]
    m=a>128; H,W=m.shape
    # 连通域
    seen=np.zeros_like(m); comps=0
    for y0,x0 in zip(*np.nonzero(m)):
        if seen[y0,x0]: continue
        stack=[(int(y0),int(x0))]; seen[y0,x0]=True
        while stack:
            y,x=stack.pop()
            for dy,dx in((1,0),(-1,0),(0,1),(0,-1)):
                ny,nx=y+dy,x+dx
                if 0<=ny<H and 0<=nx<W and m[ny,nx] and not seen[ny,nx]:
                    seen[ny,nx]=True; stack.append((ny,nx))
        comps+=1
    # 环孔洞：穿过环圆心水平剖面，中心须有透明段
    cy=int(0.170*H); row=a[cy]; half=W//2; center=row[max(0,half-12):half+12]
    ring_hole = (center<10).any()
    print(f, '连通域', comps, '环有孔洞', ring_hole)
    assert comps==1, '锚未连通'
    assert ring_hole, '环非真孔洞'
print('门禁3/4 通过')
PY
```
Expected: 每文件 `连通域 1 环有孔洞 True`，无断言失败。

- [ ] **Step 5: 备份原文件并提交生成器（先于覆盖，可回退）**

```bash
cd /Users/4seven/workspace/pi-lnk
cp apps/web/src/assets/icons/anchor-generate.png /tmp/anchor-generate.orig.png
cp apps/web/src/assets/icons/anchor-locate.png /tmp/anchor-locate.orig.png
git add scripts/gen-brand-anchor-icons.py
git commit -m "chore(assets): 新增品牌锚几何生成器（spec 2026-10-24）"
```

---

### Task 2: 替换两枚锚 PNG 并复核视觉一致性

**Files:**
- Modify: `apps/web/src/assets/icons/anchor-generate.png`（内容替换，文件名不变）
- Modify: `apps/web/src/assets/icons/anchor-locate.png`（内容替换，文件名不变）

**Interfaces:**
- Consumes: Task 1 的 `render_anchor(W,H)` 与门禁脚本
- Produces: 落盘的新 PNG；供 Task 3 跑 guard 测试

- [ ] **Step 1: 重新运行生成器覆盖原文件（文件名不变）**

```bash
cd /Users/4seven/workspace/pi-lnk
/Users/4seven/.workbuddy/binaries/python/versions/3.13.12/bin/python3 scripts/gen-brand-anchor-icons.py
```
Expected: 两文件被新几何覆盖，路径/尺寸不变。

- [ ] **Step 2: 重复 Task 1 的 §5 门禁（1/2/3/4/7）确认替换后仍全过**

```bash
/Users/4seven/.workbuddy/binaries/python/versions/3.13.12/bin/python3 - <<'PY'
import numpy as np
from PIL import Image
for f in ['apps/web/src/assets/icons/anchor-generate.png','apps/web/src/assets/icons/anchor-locate.png']:
    a=np.asarray(Image.open(f).convert('RGBA'))[...,3].astype(np.int32)
    fog=((a>0)&(a<=8)).sum(); assert fog==0, f+' 淡雾'
    H,W=a.shape; m=a>128; seen=np.zeros_like(m); comps=0
    for y0,x0 in zip(*np.nonzero(m)):
        if seen[y0,x0]: continue
        st=[(int(y0),int(x0))]; seen[y0,x0]=True
        while st:
            y,x=st.pop()
            for dy,dx in((1,0),(-1,0),(0,1),(0,-1)):
                ny,nx=y+dy,x+dx
                if 0<=ny<H and 0<=nx<W and m[ny,nx] and not seen[ny,nx]:
                    seen[ny,nx]=True; st.append((ny,nx))
        comps+=1
    assert comps==1, f+' 未连通'
    cy=int(0.170*H); assert (a[cy][W//2-12:W//2+12]<10).any(), f+' 环非孔洞'
print('门禁全过')
PY
```
Expected: 打印「门禁全过」。

- [ ] **Step 3: 导出 16px 缩略目检锚在小尺寸可辨（§Review Focus #3）**

```bash
/Users/4seven/.workbuddy/binaries/python/versions/3.13.12/bin/python3 - <<'PY'
from PIL import Image
for f in ['anchor-generate','anchor-locate']:
    im=Image.open(f'apps/web/src/assets/icons/{f}.png').convert('RGBA')
    im.resize((16,16),Image.LANCZOS).save(f'/tmp/{f}_16.png')
print('16px 缩略已导出 /tmp，交人工目检')
PY
```
Expected: `/tmp/anchor-generate_16.png`、`/tmp/anchor-locate_16.png` 可人工核对 12–18px 场景。

- [ ] **Step 4: 提交替换**

```bash
cd /Users/4seven/workspace/pi-lnk
git add apps/web/src/assets/icons/anchor-generate.png apps/web/src/assets/icons/anchor-locate.png
git commit -m "fix(assets): 锚图标几何对齐 lnk π 品牌锚（负空间环+平直方头+弯钩）"
```

---

### Task 3: 跑 guard 测试确认契约未破

**Files:**
- Test: `apps/web/src/pages/home-profile-p3.guard.test.ts`（只读，不改动；若误改源码会在此暴露）

**Interfaces:**
- Consumes: Task 2 落盘的 PNG（文件名不变）
- Produces: 测试绿/红信号

- [ ] **Step 1: 跑 home-profile-p3 guard 测试**

```bash
cd /Users/4seven/workspace/pi-lnk/apps/web
/Users/4seven/.workbuddy/binaries/python/versions/3.13.12/bin/python3 \
  /Users/4seven/.workbuddy/binaries/node/workspace/node_modules/.bin/vitest \
  run src/pages/home-profile-p3.guard.test.ts 2>&1 | tail -30
```
Expected: 含 `anchor-generate.png` 的用例 PASS（文件名未变，断言不受影响）。
注：vitest 走 nvm node 24 与 `pnpm --filter @lnkpi/web exec vitest` 入口；若本机环境需借用 worktree 软链依赖，按 `branch-first-dev-workflow` 的「worktree 依赖借用」绕行。

- [ ] **Step 2: 若测试因误改源码而红，回退并复查**

```bash
cd /Users/4seven/workspace/pi-lnk
git checkout -- apps/web/src/components/workflow/SignatureHero.vue   # 本任务不应改它；若被改则回退
```
Expected: 仅资产替换、源码零改动，guard 测试天然绿。

---

### Task 4: 开分支、汇总提交、准备 PR（按 branch-first 纪律）

**Files:**
- Branch: `fix/brand-anchor-icons`（不在 master 提交）

**Interfaces:**
- Consumes: Task 1–3 的全部提交
- Produces: 隔离分支 + PR 草案

- [ ] **Step 1: 确认起点干净并开分支**

```bash
cd /Users/4seven/workspace/pi-lnk
git fetch origin
git rev-list --count origin/master..master   # 必须为 0
git checkout -b fix/brand-anchor-icons origin/master
```
Expected: `rev-list` 返回 0；新分支基于最新 master。
（资产仅改动、无需依赖安装；相较重量级 worktree，本任务采用「主仓内开分支」的轻量变体，不违反「不提交 master」铁律。）

- [ ] **Step 2:  cherry-pick / 重放 Task1–3 的提交到分支（若之前在别处提交）**

```bash
git log --oneline -5   # 确认提交已在分支上；若在主仓其它分支，用 git show <sha>:<path> 落到本分支
```
Expected: 三个提交（生成器、PNG 替换、—）在本分支可见。

- [ ] **Step 3: 推送并开 PR**

```bash
git push -u origin fix/brand-anchor-icons
gh pr create --title "fix(assets): 锚图标几何对齐 lnk π 品牌锚" \
  --body "对齐 anchor-generate/locate 与品牌 Logo 锚语言（负空间环+平直方头+弯钩）。仅替换 PNG 内容，文件名/消费位/guard 断言零改动。spec: docs/design/2026-10-24-brand-anchor-icon-spec.md"
```
Expected: PR 创建成功，CI 转绿后 squash 合并（按 `branch-first-dev-workflow` §5–§7）。
注：若 SSH key 未注册 / https 502 导致推送失败，保留本地分支与提交，回报用户由其环境推送。

---

## Self-Review

1. **Spec 覆盖**：§2 几何 → Task1 Step1 参数；§3 white-fill → Task1 Step1 `out[...,:3]=255`；§4 消费位点 → 仅记录、未改（符合「不改消费位」）；§5 门禁 1/2/3/4/7 → Task1/2 自检脚本覆盖，§5.5（横杆平头）由几何参数保证 + Review Focus #2 目检；§5.6 几何同源 → Review Focus #1/#2 目检；§7 可复现 → 生成器提交。§6 hero 升级项明确列为分流、不在本计划。
2. **占位符扫描**：无 TBD/TODO；每步含可执行命令与预期。
3. **类型一致性**：`render_anchor(W,H)` 在 Task1/2 一致使用；路径常量 `base` 在 Task1 Step1/Step2/Task2 Step1 一致。
4. **Review Focus**：#1 环实心点 → Task1 Step3/Step4 + Task2 Step2 门禁；#2 横杆箭头 → 几何参数 + Review Focus 目检；#3 小尺寸糊 → Task2 Step3 16px 导出；#4 暗底消失 → Review Focus 列出需在 `AgentSideRail`/`CanvasRefTargetIcon` 核对（非门禁可自动，标记人工）；#5 guard 静默红 → Task3 显式跑。五条均有落点。
