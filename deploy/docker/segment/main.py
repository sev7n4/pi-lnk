from fastapi import FastAPI, Request, Response
from io import BytesIO
from hashlib import sha256

import numpy as np
import onnxruntime as ort
from PIL import Image

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
    x = float(payload["x"])
    y = float(payload["y"])
    label = int(payload.get("label", 1))

    import base64

    image_bytes = base64.b64decode(image_b64)
    emb, scale, orig = _get_embedding(image_bytes)

    coords = np.array([[(x * scale, y * scale)]], dtype=np.float32)
    labels = np.array([[label]], dtype=np.float32)
    masks, ious, _ = dec.run(
        None,
        {
            "image_embeddings": emb,
            "point_coords": coords,
            "point_labels": labels,
            "mask_input": np.zeros((1, 1, 256, 256), dtype=np.float32),
            "has_mask_input": np.array([0], dtype=np.float32),
            "orig_im_size": np.array(orig, dtype=np.float32),
        },
    )
    best = int(np.argmax(ious[0]))
    mask = masks[0, best] > 0
    out = Image.fromarray((mask * 255).astype(np.uint8), mode="L")
    buf = BytesIO()
    out.save(buf, "PNG")
    return Response(
        content=buf.getvalue(),
        media_type="image/png",
        headers={"X-Segment-Iou": f"{float(ious[0][best]):.4f}"},
    )
