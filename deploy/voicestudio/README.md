# VoiceStudio 上线 runbook（CVM 生产部署 + 三方接线 + 冒烟）

> 锚：`docs/superpowers/specs/2026-11-24-voicestudio-p1p2-implementation-spec.md` §3 / §3.3 / §3.4
> 前置：P1（PR #996）+ P2（PR #997）+ P3（PR #998）已合并；Nest 侧代码已在生产 lnkpi-api（env 门零注册）；
> 本 runbook 把「内存扩容后的人工动作」压缩为：**前置检查 → compose up → 四步物料安装 → 三方 env → 冒烟**。
> ⛔ 每步带判据；判据不过不进下一步（伪绿纪律）。

---

## 0. 前置检查（硬判据，缺一禁启动）

```bash
ssh deploy-cvm
free -h                          # 判据：available ≥ 6G（8G 扩容最低线）
df -h /                          # 判据：可用 ≥ 18G（权重 3G + runtime + ASR 0.5G + HF 缓存余量）
docker ps --format '{{.Names}}'  # 核对保留集：lnkpi-api / pintuotuo 全家 / K3s 相关
```

磁盘不足先清理（禁触 containerd overlayfs——K3s Pod 真实 FS）：

```bash
docker image prune -a --filter "until=168h"   # 可回收 ~9.4G，跑前核对保留集
docker builder prune                            # 可回收 ~3.5G
df -h /                                         # 复核 ≥ 18G
```

内存不达标 = 扩容未生效/未重启，**到此停止**（扩容前禁常驻任何 VS 引擎）。

## 1. 部署 VS 容器（compose up）

物料已在仓内（deploy.yml 整仓 tar 自动同步到 CVM）：

```bash
cd <DEPLOY_DIR>/deploy/voicestudio
openssl rand -hex 32                          # 生成 API key，记下（三方同钥）
cp env.example .env && vi .env                # 填 OMNIVOICE_API_KEY
docker compose -f docker-compose.voicestudio.yml up -d
docker logs -f voicestudio                    # 等待启动完成
curl -s http://172.17.0.1:3900/health         # 判据：200（根路径，非 /v1/health）
```

镜像 digest 锁定在 compose 内（`sha256:9cfc492a...`）；升级须改 digest + 走审计。

## 2. 安装 audio.cpp runtime（loopback-only ⇒ 必须 docker exec 触发）

```bash
docker exec voicestudio curl -s -X POST http://127.0.0.1:3900/engines/audiocpp/runtime/install
# 盯进度（SSE）：docker logs -f voicestudio
# 判据：docker exec voicestudio curl -s http://127.0.0.1:3900/engines/audiocpp/runtime/install/status → installed:true
```

## 3. 许可门 + 安装 dots.tts SOAR 权重（Apache-2.0）

dots 在 VS 许可表为 `unreviewed` ⇒ 仍须走 VS 本地许可接受门（这是 VS 的 fail-close 机制，
与模型真实许可无关；dots 真实许可 = Apache-2.0，取证见 spec §3.3）：

```bash
RID="audio-cpp/audio.cpp-gguf:dots-tts-soar-q8_0"
# ① 取 fingerprint
docker exec voicestudio curl -s "http://127.0.0.1:3900/models/licenses/acceptance/$RID"
# ② 接受（把上一步返回的 fingerprint 填入）
docker exec voicestudio curl -s -X POST http://127.0.0.1:3900/models/licenses/accept \
  -H 'Content-Type: application/json' \
  -d "{\"repo_id\":\"$RID\",\"fingerprint\":\"<上一步的值>\",\"accepted\":true}"
# ③ 安装（repo_id 字段收 catalogue identity）
docker exec voicestudio curl -s -X POST http://127.0.0.1:3900/models/install \
  -H 'Content-Type: application/json' -d "{\"repo_id\":\"$RID\"}"
# 盯进度：docker logs -f voicestudio（HF 走 hf-mirror.com，大文件可能分段重试，耐心等）
```

ASR（`transcribe` 工具用；curated CPU pick，0.5G；whisper 系许可主线 MIT，安装时留意卡片）：

```bash
RID2="Systran/faster-whisper-small"
# 同上许可门 + install 两步
```

## 4. 水印就绪（spec §3.4，合规 #2 收口——2026-11-25 spike 复测修正）

**缺口实态（spike 复测修正，比原判轻）**：AudioSeal **import 可用**（`audioseal_available:true`，无需装 ffmpeg）；
真缺口 = **AudioSeal checkpoint 未缓存 + 容器内 HF 直连失败**（checkpoint URL 硬编码 huggingface.co，
绕过 HF_ENDPOINT）。checkpoint 缺失时 embed 静默降级（合成照常、无水印直通，600s 冷却内不重试）。

```bash
# ① 预下载 AudioSeal checkpoint（走 HF 镜像站，文件名=torch.hub sha1 命名，必须精确）
docker exec -i voicestudio python3 - <<'EOF'
import hashlib, os, urllib.request
from urllib.parse import urlparse
cache = os.path.expanduser("~/.cache/audioseal")
os.makedirs(cache, exist_ok=True)
for f in ("generator_base.pth", "detector_base.pth"):
    url = f"https://huggingface.co/facebook/audioseal/resolve/main/{f}"
    name = hashlib.sha1(urlparse(url).path.encode()).hexdigest()[:24]
    dst = os.path.join(cache, name)
    if not os.path.exists(dst) or os.path.getsize(dst) < 1000:
        urllib.request.urlretrieve(url.replace("https://huggingface.co", "https://hf-mirror.com"), dst)
    print(f, "->", name, os.path.getsize(dst), "bytes")
EOF
# 判据②：GET /watermark/status → audioseal_available:true + invisible_enabled:true
curl -s -H "Authorization: Bearer <key>" http://172.17.0.1:3900/watermark/status
```

⚠️ **两条运行时知识（spike 实测）**：
- checkpoint 落在**容器层** `~/.cache/audioseal/`——容器重建（down/up、镜像升级）后重跑①+重验。
- embed 失败有 **600s 冷却**：若 speech 输出检出 `is_watermarked:false` 且容器日志已有
  `AudioSeal generator loaded`，等 10 分钟或重启容器后**重跑探针**（二次请求必过）；
  首请求在 checkpoint 就位后即可成功，生产不存在常态冷却窗口。

## 5. 三方 env 接线（同钥三处）

| 目标 | env | 值 |
|---|---|---|
| ① VS 容器（本 compose） | `OMNIVOICE_API_KEY` | 已填 .env |
| ② Nest（lnkpi-api） | `OMNIVOICE_BASE_URL` | `http://172.17.0.1:3900/v1`（**含 /v1**，spec §4.1 契约） |
| | `OMNIVOICE_API_KEY` | 同 key |
| ③ pi-runtime（K3s pod） | `OMNIVOICE_MCP_URL` | `http://172.17.0.1:3900/mcp/`（尾斜杠） |
| | `OMNIVOICE_API_KEY` | 同 key |

```bash
# Nest：改 env 走「tag 现镜像 + up -d --no-build」（保命纪律，不重 build）
docker tag <当前lnkpi-api镜像sha> lnkpi-api:local   # 若 image: 固定 tag 方式
# .env / compose environment 加上述两项后：
docker compose -f docker-compose.prod.yml up -d --no-build api
docker exec lnkpi-api printenv | grep OMNIVOICE   # 判据：count=2
```

**网络可达性验证（spec §3.2 逐条实测）**：

```bash
# ① Nest 容器 → VS
docker exec lnkpi-api curl -s -m 5 http://172.17.0.1:3900/health          # 判据：200
# ② K3s pod → 宿主 docker0（K3s DNAT 特性，可能不通）
kubectl -n pi-lnk-runtime exec <pi-runtime-pod> -- curl -s -m 5 http://172.17.0.1:3900/health
#   不通 ⇒ 改绑宿主内网 IP 或 docker network connect（把 pi-runtime 所在宿主网段放开）
```

pi-runtime 镜像更新（P2 MCP 桥四工具；生产 pod 仍是旧镜像 e41b18d7）：
见仓库 CI 构建的 pi-runtime 镜像流程（K3s 独立单元，ns=pi-lnk-runtime），
换镜像 + 上表两项 env 一起进 pod spec。

## 6. 冒烟清单（判据全过 = 上线完成）

探针脚本：**`deploy/voicestudio/smoke.py`**（无第三方依赖，python3 直接跑；本机 spike 容器已活体验证探针逻辑
13 判据形态，详见 spec §3.4 与探针 docstring）。

```bash
ssh deploy-cvm "python3 <DEPLOY_DIR>/deploy/voicestudio/smoke.py \
  --host http://172.17.0.1:3900 --key <OMNIVOICE_API_KEY> --expect-engine audiocpp-dots"
```

| # | 判据 | 方法 |
|---|---|---|
| 1 | health 200 + /v1/models 列出 audiocpp-dots + 无 OmniVoice 权重条目 | 探针判据 2 |
| 2 | watermark status available + detect confidence 达标（§4 全套） | 探针判据 3/5 |
| 3 | TTS 直连出声（model='omnivoice' 透传 audiocpp-dots）+ RIFF 头 | 探针判据 4 |
| 4 | dots Q8_0 CPU RTF 实测（17 字短句；估 0.5-3×；>30s 标注「非实时批产」） | 探针 NOTE |
| 5 | MCP init 有 session + 四工具在列 | 探针判据 6 |
| 6 | clone_voice → profile_id → list_voices 出现 → 该 voice 出声（闭环终点） | 探针判据 7 |
| 7 | design_voice 行为登记（dots 无 design 能力：拒绝/fallback 形态归档） | 探针 NOTE 8 |
| 8 | 音质听感（dots Q8_0 vs 云 TTS 对照） | 人工 |
| 9 | 画布真实路径：上传参考音频 → 克隆 → 台账 `VoiceProfileRecord`（lnk-<userId8>-<name>） | 生产 CDP/人工 |
| 10 | transcribe 中文短音频返回正确文本 | 画布/探针 |
| 11 | VS 停机 ⇒ pi-lnk 显式报错「本地引擎不可用」，云链路不受影响（两个独立会话对照） | 生产 CDP |

## 7. 回退

```bash
docker compose -f docker-compose.voicestudio.yml down   # 摘除 VS（数据卷保留）
# Nest 摘两项 OMNIVOICE env → up -d --no-build api        # voicestudio-local 行自动消失（env 门）
# pi-runtime 摘两项 env / 回滚旧镜像                        # 四工具自动消失（延迟集）
```

pi-lnk 侧零残留：模型行不注册、四工具不激活、台账表空转无害。

## 8. 已知边界（诚实登记）

- audio.cpp runtime 与 dots 权重的安装状态为**宿主卷/容器内状态**；AudioSeal checkpoint 在**容器层**（`~/.cache/audioseal/`，容器重建后重跑 §2/§3/§4；数据卷 omnivoice_data 持久化模型权重与 HF 缓存）。
- OmniVoice 权重**不安装**（CC-BY-NC）：`model='omnivoice'` 请求透传 active engine（audiocpp-dots），无 NC 风险；若 VS 行为异常回落 OmniVoice 需先过许可门且**禁用于商用素材**——冒烟判据兜底。
- dots 官方 PyTorch 运行时不支持 CPU；本部署走 audio.cpp 原生 GGUF（CPU 友好），音质为 Q8_0 量化（判据 8 听感关）。
- OmniVoice 引擎下 clone-profile 首用合成曾 500（spike 实测；本机 VM 内存 0.9G free 未完成归因）——生产为 dots 引擎，克隆路径是参考音频直喂 zero-shot（不走 OmniVoice speaker-embedding 管线），形态不同；探针判据 6 在生产复验。
