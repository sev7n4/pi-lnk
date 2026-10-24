#!/usr/bin/env python3
"""按 docs/design/2026-10-24-brand-anchor-icon-spec.md §2 绘制 canonical 锚，
输出 white-fill CSS mask PNG（几何在 alpha 通道，实色由 CSS currentColor 提供）。

4× 超采样 + LANCZOS 降采样得到抗锯齿蒙版。无外部光栅化器依赖（本机仅 Pillow）。

运行：python3 scripts/gen-brand-anchor-icons.py
"""
import numpy as np
from PIL import Image, ImageDraw

SS = 4  # 超采样倍数


def draw_anchor_gray(d, W, H):
    """在灰度画布 d（白=形, 黑=空）上绘制锚。

    几何（全部以 W/H 分数，详见 spec §2）：
    - 环：外椭圆实心（随后打孔成负空间孔洞）
    - 锚杆：竖条，自环底下方起，至钩底
    - 横杆：平直方头（无箭头）
    - 钩：底部向上兜起的弧（PIL arc 30°→150°，屏幕坐标 y 向下，90°=正下方）
    """
    cx = 0.5 * W
    r_out = 0.123 * H
    cy = 0.170 * H
    r_in = 0.057 * H

    # 环（外椭圆实心）
    d.ellipse([cx - r_out, cy - r_out, cx + r_out, cy + r_out], fill=255)

    # 锚杆：自环底下方（位于孔内之下，避免穿过孔洞）向下，至钩底略重叠
    sw = 0.066 * H
    start_y = cy + r_out - 0.02 * H   # 仍在环带内、孔洞之下 → 与环相连且孔洞全开
    sb = 0.855 * H                    # 钩最低点 = hcy + hr
    d.line([(cx, start_y), (cx, sb)], fill=255, width=round(sw))

    # 横杆（平直方头）
    sty = 0.283 * H
    st = 0.057 * H
    hl = 0.255 * W
    d.line([(cx - hl, sty), (cx + hl, sty)], fill=255, width=round(st))

    # 钩（向上兜起的弯弧）：圆心 (cx, 0.604H) 半径 0.245H，扫 30°→150° 覆盖底部
    hcy = 0.604 * H
    hr = 0.245 * H
    hw = 0.066 * H
    d.arc([cx - hr, hcy - hr, cx + hr, hcy + hr], start=30, end=150,
          fill=255, width=round(hw))


def render_anchor(W, H):
    cy = 0.170 * H
    r_in = 0.057 * H
    gray = Image.new("L", (W * SS, H * SS), 0)
    d = ImageDraw.Draw(gray)
    draw_anchor_gray(d, W * SS, H * SS)

    # uint8 灰度（0/255），避免 float32 'F' 模式 resize 的数值不稳
    a = np.array(gray, dtype=np.uint8)  # 拷贝，PIL 数组只读
    cx = 0.5 * W * SS
    yy, xx = np.mgrid[0:H * SS, 0:W * SS]
    # 打孔：环内半径内置 0 → 负空间真孔洞。锚杆起点在孔洞之下，不受影响。
    hole = ((xx - cx) ** 2 + (yy - cy * SS) ** 2) <= (r_in * SS) ** 2
    a[hole] = 0

    # BOX 降采样（无负瓣）：目标像素 = 其 4×4 超采样块内墨像素均值。
    # 细锚杆（超采样约 28px 宽）中心块恒为满值 → 不再被 LANCZOS 负瓣压断；
    # 边缘块为分数值 → 仍保留抗锯齿。
    big = Image.fromarray(a, mode="L")
    small = big.resize((W, H), Image.BOX)
    g = np.asarray(small, dtype=np.float32)
    out = np.zeros((H, W, 4), dtype=np.uint8)
    out[..., 0] = 255
    out[..., 1] = 255
    out[..., 2] = 255
    out[..., 3] = np.clip(g, 0, 255).round().astype(np.uint8)
    return Image.fromarray(out, "RGBA")


def main():
    base = "apps/web/src/assets/icons"
    targets = [("anchor-generate", 94, 106), ("anchor-locate", 93, 93)]
    for name, W, H in targets:
        im = render_anchor(W, H)
        im.save(f"{base}/{name}.png")
        print(f"wrote {base}/{name}.png {im.size}")


if __name__ == "__main__":
    main()
