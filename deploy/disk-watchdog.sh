#!/usr/bin/env bash
# pi-lnk 磁盘水位巡检断言（2026-11-05 91% 爆盘后加装）
#
# 定位：**在 CVM 上执行**（与 observability-watchdog.sh 同款：GitHub runner 连不上
# 机器上的 Prometheus/文件系统，但能 SSH 进来 ⇒ 断言在机器上跑，判定回 CI）。
#
# 为什么需要它（2026-11-05 的真实教训）：
#   disk-guard.sh 是**自愈**机制 —— 它只在「已经告警」之后才动手清理。
#   换句话说：**自愈不能替代告警**。
#   91% 那次是腾讯云监控先报的警，等人看到时 kubelet 已经在
#   `FreeDiskSpaceFailed`（"Attempted to free 4.3GB, but found 0 bytes eligible"），
#   根分区只剩 4.0G —— 距离驱逐线 6.3G 只差 2.3G。
#   ⇒ 必须在水位**越过驱逐线之前**就有人知道。
#
# 与 disk-guard.sh 的分工：
#   disk-guard.sh        —— 事后清理（自愈）
#   disk-watchdog.sh     —— 事前告警（巡检，失败即 CI 红）
#
# 断言项（每一项都是「本次爆盘的真实占用来源」，不是泛泛看 df）：
#   1. 根分区可用空间        —— 总闸门
#   2. 根分区使用率          —— 与告警口径一致（腾讯云按百分比报）
#   3. registry blob 体积    —— 本次第二大来源（4.8G / 132 个 tag）
#   4. registry tag 数       —— 防止 tag 数再次失控（增长趋势比绝对值更早报警）
#   5. containerd 镜像存储   —— 本次第一大来源（12G，在 /var/lib/containerd 不在 /var/lib/docker）
#   6. sessions PVC 体积     —— 本次第四大来源（1.7G / 200 个目录）
#   7. 生产库备份份数与体积  —— 本次第三大来源（7 份 × 139M）
#   8. disk-guard 自愈有效性 —— 机制是否真的在跑（对照它的日志）
#   9. /tmp 取证副本体积     —— 2026-11-12 爆盘根因（agent 生产验证只读副本未即时清）
#
# 用法：bash disk-watchdog.sh
# 退出码：0 = 全部通过；1 = 有断言失败（CI 会红 + 可选 webhook 告警）
set -uo pipefail

# 阈值（单位：KB / 个）。可用环境变量覆盖。
DISK_TOTAL_KB="${DISK_TOTAL_KB:-41943040}"        # 40G 分区
AVAIL_WARN_KB="${DISK_AVAIL_WARN_KB:-10485760}"    # 10G：日常清理线
AVAIL_FAIL_KB="${DISK_AVAIL_FAIL_KB:-6815744}"     # 6.3G：kubelet 15% 驱逐线
USE_WARN_PCT="${DISK_USE_WARN_PCT:-80}"            # 百分比告警线（与腾讯云口径一致；用户要求 80% 起报）
USE_FAIL_PCT="${DISK_USE_FAIL_PCT:-90}"            # 91% 那次就是这个水位
REG_BLOB_WARN_MB="${DISK_REG_BLOB_WARN_MB:-3000}"  # registry blob 3G 起报
REG_TAG_WARN="${DISK_REG_TAG_WARN:-40}"             # registry tag 数
SESSIONS_WARN_MB="${DISK_SESSIONS_WARN_MB:-4000}"  # sessions PVC 4G 起报（常态 ~2.4G/138 目录，避免永久红）
DB_BAK_WARN_N="${DISK_DB_BAK_WARN_N:-4}"            # DB 备份份数
DB_BAK_WARN_MB="${DISK_DB_BAK_WARN_MB:-800}"       # DB 备份总体积

FAILED=0
val() { printf '%s=%s\n' "$1" "$2"; }
fail() { printf 'FAIL: %s\n' "$1"; FAILED=1; }

printf '== pi-lnk 磁盘水位巡检 ==\n'

# ── 断言 1/2：根分区可用空间与使用率 ───────────────────────────────────────
AVAIL_KB=$(df --output=avail -k / | tail -1)
SIZE_KB=$(df --output=size -k / | tail -1)
USED_KB=$(df --output=used -k / | tail -1)
USE_PCT=$(awk -v u="$USED_KB" -v s="$SIZE_KB" 'BEGIN{printf "%.1f", (s+0>0)? u/s*100 : 0}')
val avail_kb "$AVAIL_KB"
val size_kb "$SIZE_KB"
val use_pct "$USE_PCT"

if [ "$AVAIL_KB" -lt "$AVAIL_FAIL_KB" ]; then
  fail "根分区可用 ${AVAIL_KB}KB 已低于 kubelet 驱逐线 ${AVAIL_FAIL_KB}KB（$USE_PCT%）—— 可能正在驱逐 Pod"
elif [ "$AVAIL_KB" -lt "$AVAIL_WARN_KB" ]; then
  fail "根分区可用 ${AVAIL_KB}KB 低于日常清理线 ${AVAIL_WARN_KB}KB（$USE_PCT%）"
fi

if awk -v p="$USE_PCT" -v t="$USE_FAIL_PCT" 'BEGIN{exit (p+0>=t+0)?0:1}'; then
  fail "根分区使用率 ${USE_PCT}% 已达/超过 ${USE_FAIL_PCT}%（告警口径）"
elif awk -v p="$USE_PCT" -v t="$USE_WARN_PCT" 'BEGIN{exit (p+0>=t+0)?0:1}'; then
  fail "根分区使用率 ${USE_PCT}% 已达/超过 ${USE_WARN_PCT}%（告警口径）"
fi

# ── 断言 3/4：registry blob 体积与 tag 数 ─────────────────────────────────
REG_BLOB_MB=0
REG_TAG_N=0
if [ -d /data/pi-registry/docker/registry/v2/blobs ]; then
  REG_BLOB_MB=$(du -sm /data/pi-registry/docker/registry/v2/blobs 2>/dev/null | cut -f1)
  REG_BLOB_MB=${REG_BLOB_MB:-0}
  REG_TAG_N=$(ls -1 /data/pi-registry/docker/registry/v2/repositories/pi-runtime/_manifests/tags 2>/dev/null | wc -l)
fi
val registry_blob_mb "$REG_BLOB_MB"
val registry_tag_count "$REG_TAG_N"
if [ "$REG_BLOB_MB" -ge "$REG_BLOB_WARN_MB" ]; then
  fail "registry blob 已达 ${REG_BLOB_MB}MB（阈值 ${REG_BLOB_WARN_MB}MB）"
fi
if [ "$REG_TAG_N" -ge "$REG_TAG_WARN" ]; then
  fail "registry tag 数已达 ${REG_TAG_N}（阈值 ${REG_TAG_WARN}）—— tag 治理未生效"
fi

# ── 断言 5：镜像数量（**不在** /var/lib/docker，第一次排查时找错了地方）──────
# ⚠️ 为什么不用「containerd 总体积」当判据：
#   /var/lib/containerd 是 Docker 26 的镜像层存储（11G），但里面绝大部分是
#   **其他项目**（pintuotuo-* / prometheus / grafana / litellm…）的合法镜像，
#   红线不允许碰它们 ⇒ 绝对体积涨了不代表有问题，判据必然误报。
#   真正由我们管控、且会无限增长的是**我们自己仓库的镜像数量**
#   （keep-N 策略就是管这个的）⇒ 判据换成「本项目镜像个数」。
CTR_MB=0
if [ -d /var/lib/containerd ]; then
  CTR_MB=$(du -sm /var/lib/containerd 2>/dev/null | cut -f1)
  CTR_MB=${CTR_MB:-0}
fi
val containerd_mb "$CTR_MB"

API_IMG_N=$(docker images lnkpi-api --format '{{.ID}}' 2>/dev/null | sort -u | wc -l)
RT_IMG_N=$(docker images 127.0.0.1:5000/pi-runtime --format '{{.ID}}' 2>/dev/null | sort -u | wc -l)
API_IMG_N=${API_IMG_N:-0}; RT_IMG_N=${RT_IMG_N:-0}
val lnkpi_api_image_count "$API_IMG_N"
val pi_runtime_image_count "$RT_IMG_N"
# keep-N=3 ⇒ 允许 3 个 + 1 个余量（构建中途可能短暂多一个）
if [ "$API_IMG_N" -gt 5 ]; then
  fail "lnkpi-api 镜像数 ${API_IMG_N} 超过 keep-N 上限（keep=3 + 余量）—— keep-N 治理未生效"
fi
if [ "$RT_IMG_N" -gt 5 ]; then
  fail "pi-runtime 镜像数 ${RT_IMG_N} 超过 keep-N 上限（keep=3 + 余量）—— keep-N 治理未生效"
fi

# ── 断言 6：sessions PVC ──────────────────────────────────────────────────
SESS_MB=0
SESS_N=0
for d in /var/lib/rancher/k3s/storage/*pi-lnk-runtime-sessions*; do
  [ -d "$d" ] || continue
  m=$(du -sm "$d" 2>/dev/null | cut -f1); SESS_MB=$((SESS_MB + ${m:-0}))
  n=$(ls -1 "$d" 2>/dev/null | wc -l); SESS_N=$((SESS_N + n))
done
val sessions_pvc_mb "$SESS_MB"
val sessions_pvc_dirs "$SESS_N"
if [ "$SESS_MB" -ge "$SESSIONS_WARN_MB" ]; then
  fail "sessions PVC 已达 ${SESS_MB}MB（阈值 ${SESSIONS_WARN_MB}MB）"
fi

# ── 断言 7：生产库备份份数与体积 ──────────────────────────────────────────
BAK_N=0
BAK_MB=0
if docker ps --format '{{.Names}}' 2>/dev/null | grep -qx lnkpi-api; then
  BAK_N=$(docker exec lnkpi-api sh -c 'ls -1 /app/apps/server/data/lnkpi.db.bak-* 2>/dev/null | wc -l' 2>/dev/null || echo 0)
  BAK_MB=$(docker exec lnkpi-api sh -c 'du -sm /app/apps/server/data 2>/dev/null | cut -f1' 2>/dev/null || echo 0)
fi
BAK_N=${BAK_N:-0}; BAK_MB=${BAK_MB:-0}
val db_backup_count "$BAK_N"
val db_data_mb "$BAK_MB"
if [ "$BAK_N" -gt "$DB_BAK_WARN_N" ]; then
  fail "生产库备份 ${BAK_N} 份超过 ${DB_BAK_WARN_N} 份"
fi

# ── 断言 8：disk-guard 自愈机制是否真的在跑 ───────────────────────────────
# 「装了机制」≠「机制生效」。判据：日志里最近一次运行的记录时间在 48h 内，
# 且最近一次运行后没有出现「读不到运行态镜像引用」的 fail-safe 跳过
# （那是 2026-11-05 缺口 1 的指纹：cron PATH 缺 /usr/local/bin ⇒ kubectl 不可见）。
GUARD_LOG=/var/log/disk-guard.log
if [ -f "$GUARD_LOG" ]; then
  # ⚠️ 只看**最后一次运行之后**的日志。
  #    用 tail -N 会把历史记录也算进来 —— 修复前的 fail-safe 跳过会永久留在日志里，
  #    导致「修好了但断言仍红」（实测：修完 PATH 缺口后，tail -200 里仍有旧记录）。
  LAST_RUN=$(grep -E 'avail=[0-9]+KB' "$GUARD_LOG" 2>/dev/null | tail -1)
  LAST_TS=$(printf '%s' "$LAST_RUN" | cut -d' ' -f1-2)
  val disk_guard_last_run "${LAST_TS:-<none>}"
  if [ -n "$LAST_TS" ]; then
    AGE_H=$(python3 - "$LAST_TS" <<'PYEOF' 2>/dev/null || echo 9999
import sys, datetime
try:
    ts = datetime.datetime.strptime(sys.argv[1], "%Y-%m-%d %H:%M:%S")
    print(int((datetime.datetime.now() - ts).total_seconds() / 3600))
except Exception:
    print(9999)
PYEOF
)
    val disk_guard_age_hours "$AGE_H"
    if [ "${AGE_H:-9999}" -gt 48 ]; then
      fail "disk-guard 最近一次运行距今 ${AGE_H}h（>48h）—— 自愈机制没在跑"
    fi
    # 最后一次运行**之后**的日志（awk 从最后一次 avail= 行往后取）
    SINCE=$(awk -v ts="$LAST_TS" '
      index($0, ts) && /avail=[0-9]+KB/ { found=1 }
      found { print }
    ' "$GUARD_LOG" 2>/dev/null)
    # fail-safe 跳过 = 读不到运行态镜像引用 ⇒ kubectl 不可见（缺口 1 指纹）
    SKIP_N=$(printf '%s\n' "$SINCE" | grep -c "读不到运行态镜像引用" || true)
    val disk_guard_failsafe_skips "${SKIP_N:-0}"
    if [ "${SKIP_N:-0}" -gt 0 ]; then
      fail "disk-guard 最近一次运行后出现 ${SKIP_N} 次「读不到运行态镜像引用」⇒ kubectl 不可见，pi-runtime 镜像治理未生效（cron PATH 缺 /usr/local/bin）"
    fi
  else
    fail "disk-guard 日志无运行记录 —— 自愈机制没在跑"
  fi
else
  fail "disk-guard 日志不存在 $GUARD_LOG —— 自愈机制没装"
fi

# ── 断言 9：agent 生产取证只读副本（2026-11-12 爆盘根因）────────────────────
# 根因：agent 做生产验证时 docker cp 出只读 DB 副本到 /tmp（p2-*.db /
#   lnkpi-*.db / pi-probe.db / v5*.db / d2-*.db / w1c-*.db / *-prod-*.db /
#   *-copy.db），做完未即时清理 ⇒ 2026-11-12 累计 ~6.7GB 撑爆 ephemeral-storage，
#   kubelet 驱逐 pi-runtime、模型请求卡死。这些副本纯只读、命名高度特异，
#   disk-guard.sh 缺口 5 已负责日常回收，但**巡检侧也要能看到它们的体积**，
#   否则下一次撑爆前没人知道。阈值 2048MB（≈2G，已逼近驱逐线余量）。
TMP_FORENSIC_MB=$(find /tmp -maxdepth 1 -type f \( -name 'p2-*.db' -o -name 'lnkpi-*.db' -o -name 'pi-probe.db' -o -name 'v5*.db' -o -name 'd2-*.db' -o -name 'w1c-*.db' -o -name '*-prod-*.db' -o -name '*-copy.db' \) -printf '%s\n' 2>/dev/null | awk '{s+=$1} END{printf "%.0f", (s+0)/1048576}')
TMP_FORENSIC_MB=${TMP_FORENSIC_MB:-0}
val tmp_forensic_mb "$TMP_FORENSIC_MB"
if [ "$TMP_FORENSIC_MB" -gt 2048 ]; then
  fail "/tmp 取证副本已达 ${TMP_FORENSIC_MB}MB（阈值 2048MB）"
fi

if [ "$FAILED" = "0" ]; then
  printf 'OK: 全部断言通过\n'
  exit 0
fi
printf 'FAILED: 存在不达标项\n'
exit 1
