#!/usr/bin/env python3
"""从品牌 icon-only 资产生成两类锚图标。

源资产：lnk-pi-logo_assets/c80d7b56-lnk-pi-logo_A_icon-only_v2_1024px_transparent.png
  —— 黑底透明徽标：外细环 + 黑盘 + 锚（负空间挖空）+ 左侧波浪装饰。

产出两类（与组件消费位点锁定）：

  A. 纯锚（white-fill 蒙版，CSS mask + currentColor 上色，随主题变）：
     anchor-generate.png (94×106)  → SignatureHero / DockGenerateButton
     anchor-locate.png  (93×93)   → AgentSideRail 微图标（11/15px）
     说明：只取中央锚，丢弃外环/黑盘/波浪。

  B. 双色徽标（自带颜色位图，<img> 渲染，不随主题）：
     anchor-badge.png   (256×256) → SlideToCreate / CanvasRefTargetIcon
       = 黑盘 + 白锚 + 外环 + 左侧波浪。
       关键处理：锚洞（黑盘内的负空间）填充为「真实白」，使徽标在任意底色
       上都可辨；环与盘之间的留白保留透明（维持品牌「环-盘分离」质感）。
       黑盘/外环/波浪保持源资产的黑，透明外缘。

运行：python3 scripts/gen-brand-anchor-icons.py
依赖：Pillow + numpy（本机已装）
"""
import os
import numpy as np
from PIL import Image
from collections import deque

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(
    REPO_ROOT,
    "lnk-pi-logo_assets",
    "c80d7b56-lnk-pi-logo_A_icon-only_v2_1024px_transparent.png",
)
OUT_GEN = os.path.join(REPO_ROOT, "apps/web/src/assets/icons/anchor-generate.png")
OUT_LOC = os.path.join(REPO_ROOT, "apps/web/src/assets/icons/anchor-locate.png")
OUT_BADGE = os.path.join(REPO_ROOT, "apps/web/src/assets/icons/anchor-badge.png")

THRESH = 40  # alpha 阈值：< THRESH 视为透明


def _load():
    return np.asarray(Image.open(SRC).convert("RGBA"))


def _flood_borders(mask):
    """从四边 flood-fill 标记连通区（mask=True 视为可走）。返回标记 bool。"""
    H, W = mask.shape
    mark = np.zeros((H, W), bool)
    st = deque()
    for x in range(W):
        for y in (0, H - 1):
            if mask[y, x] and not mark[y, x]:
                mark[y, x] = True
                st.append((y, x))
    for y in range(H):
        for x in (0, W - 1):
            if mask[y, x] and not mark[y, x]:
                mark[y, x] = True
                st.append((y, x))
    while st:
        y, x = st.pop()
        for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            ny, nx = y + dy, x + dx
            if 0 <= ny < H and 0 <= nx < W and mask[ny, nx] and not mark[ny, nx]:
                mark[ny, nx] = True
                st.append((ny, nx))
    return mark


def extract_anchor_mask(arr):
    """返回 (H,W) bool 掩码：品牌的实心填充锚（已丢弃外环/黑盘/波浪）。"""
    H, W, _ = arr.shape
    trans = arr[..., 3] < THRESH

    bg = _flood_borders(trans)          # 外部背景透明
    pos = trans & (~bg)                 # 内部封闭透明 = 锚 + 波浪（负形）

    cyc, cxc = H // 2, W // 2
    lab = np.zeros((H, W), np.int32)
    ncomp = 0
    for yy in range(H):
        for xx in range(W):
            if pos[yy, xx] and lab[yy, xx] == 0:
                ncomp += 1
                st = deque([(yy, xx)])
                lab[yy, xx] = ncomp
                while st:
                    a, b = st.pop()
                    for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                        na, nb = a + dy, b + dx
                        if 0 <= na < H and 0 <= nb < W and pos[na, nb] and lab[na, nb] == 0:
                            lab[na, nb] = ncomp
                            st.append((na, nb))
    anchor_id = int(lab[cyc, cxc])
    if anchor_id == 0:
        sizes = np.bincount(lab.ravel())[1:]
        anchor_id = int(np.argmax(sizes)) + 1
    return lab == anchor_id


def extract_badge_rgba(arr):
    """返回品牌双色徽标的 RGBA 图像（黑盘+白锚+外环+波浪，透明外缘）。

    锚洞（黑盘内负空间）填真实白；环-盘留白保留透明。
    """
    H, W, _ = arr.shape
    alpha = arr[..., 3]
    opaque = alpha >= THRESH
    trans = ~opaque

    exterior = _flood_borders(trans)     # 外部透明（含环外、波外）
    interior = trans & (~exterior)       # 封闭透明：锚洞 + 环-盘留白 + 波内凹

    # 最大不透明连通分量 = 黑盘
    lab_o = np.zeros((H, W), np.int32)
    n = 0
    disk_bbox = None
    disk_size = -1
    for yy in range(H):
        for xx in range(W):
            if opaque[yy, xx] and lab_o[yy, xx] == 0:
                n += 1
                st = deque([(yy, xx)])
                lab_o[yy, xx] = n
                cnt = 0
                xs, ys = [], []
                while st:
                    a, b = st.pop()
                    cnt += 1
                    xs.append(b)
                    ys.append(a)
                    for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                        na, nb = a + dy, b + dx
                        if 0 <= na < H and 0 <= nb < W and opaque[na, nb] and lab_o[na, nb] == 0:
                            lab_o[na, nb] = n
                            st.append((na, nb))
                if cnt > disk_size:
                    disk_size = cnt
                    disk_bbox = (min(xs), min(ys), max(xs), max(ys))

    out = arr.copy()
    dx0, dy0, dx1, dy1 = disk_bbox
    # 内部透明分量：bbox 完全落在黑盘内 ⇒ 锚洞 ⇒ 填白
    lab_i = np.zeros((H, W), np.int32)
    m = 0
    for yy in range(H):
        for xx in range(W):
            if interior[yy, xx] and lab_i[yy, xx] == 0:
                m += 1
                st = deque([(yy, xx)])
                lab_i[yy, xx] = m
                cx, cy = [], []
                while st:
                    a, b = st.pop()
                    cx.append(b)
                    cy.append(a)
                    for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                        na, nb = a + dy, b + dx
                        if 0 <= na < H and 0 <= nb < W and interior[na, nb] and lab_i[na, nb] == 0:
                            lab_i[na, nb] = m
                            st.append((na, nb))
                bx0, bx1 = min(cx), max(cx)
                by0, by1 = min(cy), max(cy)
                if bx0 >= dx0 and bx1 <= dx1 and by0 >= dy0 and by1 <= dy1:
                    for a, b in zip(cy, cx):
                        out[a, b, 0] = out[a, b, 1] = out[a, b, 2] = 255
                        out[a, b, 3] = 255

    # 裁到整体不透明 bbox
    ys_op, xs_op = np.where(opaque)
    x0, x1 = xs_op.min(), xs_op.max()
    y0, y1 = ys_op.min(), ys_op.max()
    return Image.fromarray(out[y0:y1 + 1, x0:x1 + 1], "RGBA")


def render_mask(mask, tw, th, pad=0.06):
    """把 bool 掩码等比居中缩放为 white-fill RGBA（alpha=掩码）。"""
    ch, cw = mask.shape
    s = min(tw * (1 - 2 * pad) / cw, th * (1 - 2 * pad) / ch)
    nw, nh = max(1, round(cw * s)), max(1, round(ch * s))
    im = Image.fromarray((mask * 255).astype(np.uint8), "L").resize((nw, nh), Image.LANCZOS)
    canvas = np.zeros((th, tw), np.uint8)
    ox, oy = (tw - nw) // 2, (th - nh) // 2
    canvas[oy:oy + nh, ox:ox + nw] = np.asarray(im)
    out = np.zeros((th, tw, 4), np.uint8)
    out[..., 0] = out[..., 1] = out[..., 2] = 255
    out[..., 3] = canvas
    return Image.fromarray(out, "RGBA")


def to_square(img, size):
    """把任意尺寸 RGBA 等比居中放进 size×size 透明方块。"""
    w, h = img.size
    s = size / max(w, h)
    nw, nh = max(1, round(w * s)), max(1, round(h * s))
    res = img.resize((nw, nh), Image.LANCZOS)
    canvas = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    canvas.paste(res, ((size - nw) // 2, (size - nh) // 2))
    return canvas


if __name__ == "__main__":
    if not os.path.exists(SRC):
        raise SystemExit(f"缺失源资产：{SRC}")
    arr = _load()

    mask = extract_anchor_mask(arr)
    render_mask(mask, 94, 106).save(OUT_GEN)
    render_mask(mask, 93, 93).save(OUT_LOC)

    badge = extract_badge_rgba(arr)
    to_square(badge, 256).save(OUT_BADGE)

    print(f"wrote {OUT_GEN} (94x106)  [pure anchor mask]")
    print(f"wrote {OUT_LOC}  (93x93)   [pure anchor mask]")
    print(f"wrote {OUT_BADGE} (256x256) [two-color badge, anchor filled white]")
