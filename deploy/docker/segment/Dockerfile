FROM python:3.11-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -i https://pypi.tuna.tsinghua.edu.cn/simple -r requirements.txt
# 模型预置进镜像层（MobileSAM ONNX，Apache-2.0，encoder 28MB + decoder 16MB）。
# 走 hf-mirror 国内直连；不挂 volume，避免 matting-models 空卷遮蔽镜像层模型的坑。
RUN mkdir -p /app/models \
    && python -c "import urllib.request,zipfile; urllib.request.urlretrieve('https://hf-mirror.com/vietanhdev/segment-anything-onnx-models/resolve/main/mobile_sam_20230629.zip','/tmp/mobile_sam.zip'); zipfile.ZipFile('/tmp/mobile_sam.zip').extractall('/app/models')" \
    && rm /tmp/mobile_sam.zip \
    && ls -la /app/models
COPY main.py .
EXPOSE 8000
# 编码会话预热（首请求编译耗时，health 放宽 start_period）
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
