# pi-lnk-runtime Helm Chart

pi-runtime（vendored pi-agent-core 0.85.1）在 K3s 上的部署单元 —— spec §5.2。

## 与 spec §5 的已记录偏离

| spec 原文 | 实际 | 原因 |
|---|---|---|
| 容器端口 8080 | **8100** | 端口定案晚于 spec 写作（AGENTS.md 端口表：避让 CVM 8080/8000） |
| chart fork 自 bitnami/common | 自包含 helpers | 单服务零子 chart 依赖，自写 ~20 行 helpers 少一层供应链与 fetch |
| dev 也用 Traefik Ingress | **NodePort 30100** + Traefik/servicelb 禁用 | CVM 生产机内存余量 ~1GB；Nest（同机 docker）走 node IP:30100，Day-1 够用 |
| dev PVC 10Gi | dev 5Gi | 磁盘余 8.5G，P0 shadow 阶段会话量小 |

## 部署（CVM 单节点 dev）

```bash
# 1. registry 已就绪：127.0.0.1:5000（docker container pi-registry，数据卷 /data/pi-registry）
# 2. 镜像构建推送（repo 根目录为构建上下文）：
rsync -aR --exclude node_modules services/pi-runtime pnpm-workspace.yaml package.json pnpm-lock.yaml vendor deploy-cvm:pi-lnk-build/
ssh deploy-cvm "cd ~/pi-lnk-build && docker build -f services/pi-runtime/Dockerfile -t 127.0.0.1:5000/pi-runtime:0.0.1 . && docker push 127.0.0.1:5000/pi-runtime:0.0.1"

# 3. helm 安装（CVM）：
helm upgrade --install pi-lnk-runtime-dev charts/pi-lnk-runtime \
  -n pi-lnk-runtime --create-namespace \
  --set secrets.AGNES_API_KEY="$AGNES_API_KEY" \
  -f charts/pi-lnk-runtime/values.yaml

# 4. 冒烟：
curl http://<node-ip>:30100/healthz
```

## NetworkPolicy 白名单参数

- `networkPolicy.ingressCidrs`：NodePort 来源 CIDR（dev: 宿主机 docker 网段 172.17.0.0/16 + 节点网段）
- `networkPolicy.egressCidrs`：LLM provider 网段（默认 0.0.0.0/0:443，可收紧到 Agnes 出口 IP）

## 升级纪律（spec §5.2.3）

vendor 版本升级 → `Chart.yaml appVersion` 同步 bump → `values.yaml image.tag` 更新 → helm upgrade（强制重新部署）。
