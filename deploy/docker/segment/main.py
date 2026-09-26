from fastapi import FastAPI, Request, Response
from io import BytesIO
from hashlib import sha256

import numpy as np
import onnxruntime as ort
from PIL import Image, ImageFilter

app = FastAPI()

# MobileSAM ONNX（Apache-2.0，预置在镜像层）。
# encoder 输入为 rank-3 HWC [H,W,3]，已本地验证（/tmp/mobilesam_test.py 契约）：
# resize 长边到 1024 → 右下 pad MEAN 像素 → (x-MEAN)/STD → mask 由 decoder 按原图尺寸输出。
MODEL_DIR = "/app/models"
MEAN = np.array([123.675, 116.28, 103.53], dtype=np.float32)
STD = np.array([58.395, 57.12, 57.375], dtype=np.float32)
INPUT_SIZE = 1024
# 同图多次点选复用 embedding（256*64*64*4B ≈ 4MB/条，LRU 4 条 ≈ 16MB）
EMBEDDING_CACHE_MAX = 4
_embedding_cache: dict[str, np.ndarray] = {}
_embedding_order: list[str] = []

sess_opts = ort.SessionOptions()
sess_opts.intra_op_num_threads = 2
sess_opts.inter_op_num_threads = 1
enc = ort.InferenceSession(
    f"{MODEL_DIR}/mobile_sam.encoder.onnx",
    sess_options=sess_opts,
    providers=["CPUExecutionProvider"],
)
dec = ort.InferenceSession(
    f"{MODEL_DIR}/sam_vit_h_4b8939.decoder.onnx",
    sess_options=sess_opts,
    providers=["CPUExecutionProvider"],
)


@app.get("/health")
def health():
    return {"ok": True, "model": "mobile-sam-onnx"}


def _get_embedding(image_bytes: bytes) -> tuple[np.ndarray, float, tuple[int, int]]:
    key = sha256(image_bytes).hexdigest()
    cached = _embedding_cache.get(key)
    if cached is not None:
        # 命中缓存仍需 scale/orig；代价低，重算几何即可
        img = Image.open(BytesIO(image_bytes))
        w, h = img.size
        scale = INPUT_SIZE / max(w, h)
        return cached, scale, (h, w)

    img = Image.open(BytesIO(image_bytes)).convert("RGB")
    w, h = img.size
    scale = INPUT_SIZE / max(w, h)
    new_w, new_h = round(w * scale), round(h * scale)
    resized = img.resize((new_w, new_h), Image.BILINEAR)
    padded = Image.new("RGB", (INPUT_SIZE, INPUT_SIZE))
    padded.paste(resized, (0, 0))
    norm = (np.asarray(padded, dtype=np.float32) - MEAN) / STD
    emb = enc.run(["image_embeddings"], {"input_image": norm})[0]

    _embedding_cache[key] = emb
    _embedding_order.append(key)
    while len(_embedding_order) > EMBEDDING_CACHE_MAX:
        _embedding_cache.pop(_embedding_order.pop(0), None)
    return emb, scale, (h, w)


@app.post("/segment")
async def segment(req: Request):
    payload = await req.json()
    image_b64 = payload.get("image") or ""
    # 提示方式（三选一或组合，向后兼容旧的单点 x/y/label）：
    # - box: [x1, y1, x2, y2] 原图像素框（SAM box prompt，labels 2/3）
    # - points: [{"x","y","label"}] 多点，label 1=正点 0=负点
    # - x/y + label: 旧单点形式
    box = payload.get("box")
    points = payload.get("points")
    if box is None and points is None:
        points = [
            {
                "x": float(payload["x"]),
                "y": float(payload["y"]),
                "label": int(payload.get("label", 1)),
            }
        ]
    mask_index = payload.get("mask_index")
    # 选区扩大/收缩（像素，正=膨胀 负=腐蚀），用于焦点粒度微调（本导出仅单候选蒙版，
    # 无法做 SAM 多粒度切换，形态学缩放即「焦点大小控制」的落地形式）。
    dilate = int(payload.get("dilate", 0) or 0)

    import base64

    image_bytes = base64.b64decode(image_b64)
    emb, scale, orig = _get_embedding(image_bytes)

    coords: list[tuple[float, float]] = []
    labels: list[int] = []
    if box is not None:
        x1, y1, x2, y2 = (float(v) * scale for v in box)
        coords += [(x1, y1), (x2, y2)]
        labels += [2, 3]
    for p in points or []:
        coords.append((float(p["x"]) * scale, float(p["y"]) * scale))
        labels.append(int(p.get("label", 1)))

    masks, ious, _ = dec.run(
        None,
        {
            "image_embeddings": emb,
            "point_coords": np.array([coords], dtype=np.float32),
            "point_labels": np.array([labels], dtype=np.float32),
            "mask_input": np.zeros((1, 1, 256, 256), dtype=np.float32),
            "has_mask_input": np.array([0], dtype=np.float32),
            "orig_im_size": np.array(orig, dtype=np.float32),
        },
    )
    n_cand = int(masks.shape[1])
    candidates = [
        {"iou": float(ious[0][i]), "area": int(np.count_nonzero(masks[0, i] > 0))}
        for i in range(n_cand)
    ]
    if mask_index is not None and 0 <= int(mask_index) < n_cand:
        best = int(mask_index)
    else:
        best = int(np.argmax(ious[0]))
    mask = masks[0, best] > 0
    out = Image.fromarray((mask * 255).astype(np.uint8), mode="L")
    if dilate > 0:
        out = out.filter(ImageFilter.MaxFilter(2 * dilate + 1))
    elif dilate < 0:
        out = out.filter(ImageFilter.MinFilter(2 * (-dilate) + 1))
    buf = BytesIO()
    out.save(buf, "PNG")
    import json

    return Response(
        content=buf.getvalue(),
        media_type="image/png",
        headers={
            "X-Segment-Iou": f"{float(ious[0][best]):.4f}",
            "X-Segment-Index": str(best),
            "X-Segment-Candidates": json.dumps(candidates),
        },
    )
