#!/usr/bin/env python3
"""§5 质量门禁验证：对 regenerated 锚 PNG 逐条过 spec 门禁。

用法：python3 scripts/verify-anchor-gates.py
"""
import numpy as np
from PIL import Image

BASE = "apps/web/src/assets/icons"


def load(name):
    im = Image.open(f"{BASE}/{name}.png").convert("RGBA")
    return np.asarray(im, dtype=np.uint8)


def bfs_components(mask):
    """返回 4-连通分量数（mask: bool 2D）。"""
    H, W = mask.shape
    seen = np.zeros((H, W), dtype=bool)
    comps = 0
    stack = []
    for y0 in range(H):
        for x0 in range(W):
            if mask[y0, x0] and not seen[y0, x0]:
                comps += 1
                stack.append((y0, x0))
                seen[y0, x0] = True
                while stack:
                    y, x = stack.pop()
                    for dy, dx in ((-1, 0), (1, 0), (0, -1), (0, 1)):
                        ny, nx = y + dy, x + dx
                        if 0 <= ny < H and 0 <= nx < W and mask[ny, nx] and not seen[ny, nx]:
                            seen[ny, nx] = True
                            stack.append((ny, nx))
    return comps


def largest_cluster(mask):
    """返回 4-连通最大簇的像素数（mask: bool 2D）。"""
    H, W = mask.shape
    seen = np.zeros((H, W), dtype=bool)
    best = 0
    stack = []
    for y0 in range(H):
        for x0 in range(W):
            if mask[y0, x0] and not seen[y0, x0]:
                cnt = 0
                stack.append((y0, x0))
                seen[y0, x0] = True
                while stack:
                    y, x = stack.pop()
                    cnt += 1
                    for dy, dx in ((-1, 0), (1, 0), (0, -1), (0, 1)):
                        ny, nx = y + dy, x + dx
                        if 0 <= ny < H and 0 <= nx < W and mask[ny, nx] and not seen[ny, nx]:
                            seen[ny, nx] = True
                            stack.append((ny, nx))
                best = max(best, cnt)
    return best


def check(name, W, H, expect_cx, hole_cy, hole_r):
    print(f"\n=== {name}.png ===")
    a = load(name)
    hh, ww = a.shape[:2]
    ok = True

    # G1 尺寸精确
    sz = (hh == H and ww == W)
    print(f"[G1 尺寸] want {W}x{H} got {ww}x{hh} -> {'PASS' if sz else 'FAIL'}")
    ok &= sz

    alpha = a[..., 3]
    rgb = a[..., :3]

    # G2 白填色：alpha>0 处 RGB 必须全 255
    ink = alpha > 0
    white = np.all(rgb[ink] == 255) if ink.any() else True
    print(f"[G2 白填色] ink pixels={int(ink.sum())} all-white={bool(white)} -> {'PASS' if white else 'FAIL'}")
    ok &= white

    # G3 真孔洞：孔心内部（r <= hole_r-2.5，避开边缘 1px 抗锯齿过渡）必须全透明
    #       且环带（hole_r+1 .. r_out-1）必须实色存在 → 证明是「环」而非实心圆点。
    yy, xx = np.mgrid[0:hh, 0:ww]
    r = np.sqrt((xx - expect_cx) ** 2 + (yy - hole_cy) ** 2)
    core = r <= (hole_r - 2.5)
    ring_band = (r >= (hole_r + 1.0)) & (r <= (0.123 * H - 1.0))
    core_open = (alpha[core] < 8).all() if core.any() else False
    band_solid = (alpha[ring_band] >= 128).mean() > 0.85 if ring_band.any() else False
    hole_ok = core_open and band_solid
    print(f"[G3 真孔洞] core-open={bool(core_open)} ring-band-solid={bool(band_solid)} -> {'PASS' if hole_ok else 'FAIL'}")
    ok &= hole_ok

    # G4 单连通分量（alpha>=128）
    solid = alpha >= 128
    ncomp = bfs_components(solid)
    print(f"[G4 单连通] components={ncomp} -> {'PASS' if ncomp == 1 else 'FAIL'}")
    ok &= (ncomp == 1)

    # G5 锚杆连续：中心列 alpha 自 shank 起点到钩底应恒为实色（>=128）
    cx = int(round(expect_cx))
    # shank 起点 = hole_cy + hole_r（近似环底），终点 = 0.855H
    start_y = int(round(hole_cy + hole_r))
    sb = int(round(0.855 * H))
    col = alpha[start_y:sb, cx]
    broken = int(np.sum(col < 128))
    print(f"[G5 锚杆连续] center-col y[{start_y},{sb}] breaks(<128)={broken} -> {'PASS' if broken == 0 else 'FAIL'}")
    ok &= (broken == 0)
    # 额外：曾经断口带 y58..62（generate）必须全实
    if name == "anchor-generate":
        band = alpha[58:63, cx]
        band_ok = int(np.sum(band < 128)) == 0
        print(f"   历史断口带 y[58,63] breaks={int(np.sum(band < 128))} -> {'PASS' if band_ok else 'FAIL'}")
        ok &= band_ok

    # G6 横杆平直对称：crossbar 行（0.283H）左右墨宽应近似相等（无箭头）
    sty = int(round(0.283 * H))
    row = alpha[sty, :]
    xs = np.where(row >= 128)[0]
    if xs.size:
        left_w = int(xs.min())
        right_w = int(ww - 1 - xs.max())
        asym = abs(left_w - right_w)
        flat = asym <= 2
        print(f"[G6 横杆平直] left_margin={left_w} right_margin={right_w} asym={asym} -> {'PASS' if flat else 'FAIL'}")
        ok &= flat
    else:
        print("[G6 横杆平直] no ink row -> FAIL")
        ok = False

    # G7 无成片雾：1<=A<=20 的最大连通簇不得 >30px
    fog = (alpha >= 1) & (alpha <= 20)
    biggest = largest_cluster(fog)
    print(f"[G7 无成片雾] max fog cluster={biggest}px -> {'PASS' if biggest <= 30 else 'FAIL'}")
    ok &= (biggest <= 30)

    print(f"==> {'ALL PASS' if ok else 'GATE FAIL'}")
    return ok


def main():
    r1 = check("anchor-generate", 94, 106, expect_cx=47.0, hole_cy=18.0, hole_r=6.0)
    r2 = check("anchor-locate", 93, 93, expect_cx=46.5, hole_cy=15.8, hole_r=5.3)
    print("\n#####", "ALL GATES PASS" if (r1 and r2) else "SOME GATES FAILED")


if __name__ == "__main__":
    main()
