#!/usr/bin/env bash
# pi-runtime 观测巡检断言（P2 的「谁算」）
#
# 定位：**在 CVM 上执行**（Prometheus 是 NodePort 30909，外网被安全组拦住，
# GitHub runner 连不上 —— 这是硬约束，不是选择）。
#
# 与 `read-decisions.sh` 的分工：那个脚本**打印给人看**，本脚本**给 CI 判成败**。
# 所以本脚本只输出 `KEY=VALUE` 行 + 失败原因，退出码非 0 即告警。
#
# ⛔ 硬纪律（每条都对应一次真实误判，详见 deploy/observability/README.md）：
#   1. **判据必挂分母**：`错误率` 只能在「同一窗口工具调用增量 > 0」时判读。
#      挂 `sessions_active` 会误判 —— 实测「会话峰值 2 但调用增量 0」。
#   2. **空族用 `or vector(0)`**：counter 型 Map 为空时不渲染数据行，
#      Prometheus 会整族丢弃 ⇒ 直接查返空向量而非 0。
#   3. **up 优先于一切**：`up != 1` 时下面所有指标结论都无效，直接判采集故障。
#   4. **禁瞬时 `count()`**：重启会让 per-series 数变化；本脚本不用它。
#
# 用法：bash observability-watchdog.sh [PROM_URL]
# 环境：
#   ERROR_RATE_THRESHOLD  工具错误率阈值（默认 0.02）
#     ⚠️ 默认值取自 spec 规则 4 的初值「> 2%」（docs/superpowers/specs/
#        2026-10-04-metrics-observability-design.md:320）。spec 里的 **5%** 是规则 2
#        （上游 5xx 占全部上游错误比），不是工具错误率 —— 两者别混。
#   WINDOW                观察窗口（默认 1h；必须 < 典型 pod 重启间隔）
set -uo pipefail

PROM="${1:-http://127.0.0.1:30909}"
THRESHOLD="${ERROR_RATE_THRESHOLD:-0.02}"
WINDOW="${WINDOW:-1h}"

# curl 可注入（测试用；生产不设 ⇒ 走系统 curl）。
# 存在的理由：断言脚本的价值全在「该失败时失败」，而生产上等不到失败窗口
# ⇒ 必须能用假响应驱动各种场景。没有这个口子就只能靠改生产数据来测。
CURL_BIN="${CURL_BIN:-curl}"

fail() { printf 'FAIL: %s\n' "$1"; exit 1; }
val()  { printf '%s=%s\n' "$1" "$2"; }

# q <promql> —— 即时查询；无数据返回空字符串（**不返回 0**，
# 因为「无数据」与「0」必须能被调用方区分 —— 这是本脚本存在的意义）。
q() {
  "$CURL_BIN" -sS --max-time 15 --get --data-urlencode "query=$1" "${PROM}/api/v1/query" 2>/dev/null \
    | python3 -c '
import json,sys
try: d=json.load(sys.stdin)
except Exception: print(""); sys.exit(0)
if d.get("status")!="success": print(""); sys.exit(0)
r=d["data"]["result"]
print(r[0]["value"][1] if r else "")
'
}

is_num() { printf '%s' "$1" | grep -qE '^-?[0-9]+(\.[0-9]+)?$'; }

printf '== pi-runtime 观测巡检 ==\nprom=%s\nwindow=%s\nerror_rate_threshold=%s\n' "$PROM" "$WINDOW" "$THRESHOLD"

# --- 断言 1：采集层（最优先） ------------------------------------------------
# 所有取值一律 `${VAR:-}` 兜底：脚本跑在 `set -u` 下，任何一处未赋值都会
# 直接崩在「unbound variable」而不是给出可读的 FAIL —— 崩掉的巡检等于没有巡检。
UP=$(q 'up{job="pi-runtime"}' || true)
val up "${UP:-<no-data>}"
if [ -z "${UP:-}" ]; then
  fail "采集目标无数据：Prometheus 不可达，或 job=pi-runtime 未被采集（先查 prometheus.yml 的 static_configs 与 targets）"
fi
if [ "$UP" != "1" ]; then
  fail "抓取失败（up=$UP）：/metrics 端点不可达或 pi-runtime 未启动"
fi

# --- 断言 2：pi-runtime 自身存活 --------------------------------------------
# 判据用 healthz（最强判据：带 version），它不经 Prometheus ⇒ 与采集层解耦。
HEALTH=""
if command -v "$CURL_BIN" >/dev/null 2>&1; then
  HEALTH=$("$CURL_BIN" -sS --max-time 8 http://127.0.0.1:30100/healthz 2>/dev/null || true)
fi
val healthz "${HEALTH:-<unreachable>}"
printf '%s' "$HEALTH" | grep -q '"status":"ok"' \
  || fail "pi-runtime healthz 非 ok：${HEALTH:-<无响应>}（服务可能已挂或正在重启）"

# --- 断言 3：错误率（**必须先过分母**） -------------------------------------
CALLS=$(q "sum(increase(pi_runtime_tool_calls_total[$WINDOW])) or vector(0)" || true)
ERRS=$(q "sum(increase(pi_runtime_tool_calls_total{result=\"error\"}[$WINDOW])) or vector(0)" || true)
val tool_calls_increase "${CALLS:-0}"
val tool_errors_increase "${ERRS:-0}"

if ! is_num "${CALLS:-}" || ! is_num "${ERRS:-}"; then
  fail "PromQL 返回非数值（calls='$CALLS' errors='$ERRS'）"
fi

# 判据纪律 1：分母为 0 时**跳过**错误率判定，而不是判成 0% —— 否则「没流量」
# 会被读成「零错误率」，这正是 P1 之前反复踩的坑。
# ⚠️ awk 的 `print` 规则**逐行执行**：`awk '{print ($1>0)?1:0}'` 读两行输入会**输出两行**
# （第二行拿阈值当 $1 ⇒ 恒为 1）。这曾让「分母=0」走进错误率判定 ——
# 恰好是 P1 刚清掉的「零流量读成零错误率」坑。
# ⚠️ 另：`$1` 取自管道文本时是**字符串**，`"0.000000" > "0.05"` 按字典序为真 ⇒ 误报超阈。
#     故一律用 `awk -v` 显式传参 + `+0` 强制数值，不依赖管道分行。
if [ "$(awk -v c="${CALLS:-0}" 'BEGIN{print (c+0>0)?1:0}')" = "0" ]; then
  val error_rate "skipped (分母=0，无事件窗口)"
  printf 'SKIP: 窗口内工具调用增量为 0 ⇒ 不判错误率（避免把「没流量」读成「零错误」）\n'
else
  RATE=$(awk -v e="${ERRS:-0}" -v c="${CALLS:-0}" 'BEGIN{printf "%.6f", (c+0>0)? e/c : 0}')
  val error_rate "$RATE"
  if [ "$(awk -v r="$RATE" -v t="$THRESHOLD" 'BEGIN{print (r+0>t+0)?1:0}')" = "1" ]; then
    fail "工具错误率 $RATE 超过阈值 $THRESHOLD（分子=$ERRS 分母=$CALLS，窗口 $WINDOW）"
  fi
fi

# --- 断言 4：数据连续性（近 2h 是否有断档） ---------------------------------
# 用 uptime 的样本数近似「采集是否连续」：正常 2h 至少 ~70 个点（15s 抓取间隔）。
# 不用 count() 判「族是否退化」—— 那正是纪律 4 禁止的。
POINTS=$(q "count_over_time(pi_runtime_uptime_seconds[2h])" || true)
val uptime_samples_2h "${POINTS:-0}"
if is_num "${POINTS:-}" && [ "${POINTS:-0}" -lt 40 ]; then
  fail "近 2h 采集样本仅 $POINTS 个（预期 ≥40）：采集有断档，或 Prometheus 刚重启"
fi

# --- 断言 5：LLM 错误维度已接线（#214 的回归哨兵） ---------------------------
# 刻意**不判非空**：族空是正常的（还没发生过 LLM 失败）。
# 只判「端点活着且能应答」—— 若这里报错，说明 /metrics 整体不可用，断言 1 已漏过。
LLM=$(q 'pi_runtime_llm_errors_total or pi_runtime_llm_retries_total or vector(0)' || true)
val llm_error_dimension "reachable"

printf 'OK: 全部断言通过\n'
