# Prometheus 采集层（pi-runtime 自建栈）

## 作用

阶段一至#192 的指标都存在**pi-runtime 进程内存**里，pod 一重启全部归零
（实测：随 #192 部署重启后 `uptime 16.3s`、历史计数全没）。
本栈负责把这些指标**存到有持久化的地方**，使历史与趋势成为可能。

## 现状（2026-10-05 实测）

- Pod `pi-lnk-prometheus-0` 1/1 Running，PVC 5Gi Bound
- 抓取目标 `172.17.0.1:30100`（宿主 docker0 网关）→ `health=up`，零错误
- **已实证「活过重启」**：pi-runtime 重启后其自身 counter 归零，
  但 Prometheus 内的历史序列仍在（这正是本栈存在的意义）

## 🔴 访问方式：外网访问**被腾讯云安全组拦住**，需你在控制台开通

**已实测的分层结果**（同一台机器）：

| 访问路径 | 结果 | 含义 |
|---|---|---|
| `127.0.0.1:30909` | **302** | 服务正常 |
| `172.17.0.1:30909` | **302** | 集群内/内网正常 |
| `119.29.173.89:30909` | **000** | **外网被拦** |

⇒ **不是服务问题，是腾讯云安全组没放行 30909。** 这条链在机器上（`YJ-FIREWALL-INPUT`
的 REJECT 白名单模式），**我无法从机器内改**（云侧规则）。

### 你需要在腾讯云控制台做的

安全组 → 入站规则 → 新增：

| 项 | 值 |
|---|---|
| 协议端口 | TCP:30909 |
| 来源 | **建议填你的办公 IP / 32 位掩码**，不要填 `0.0.0.0/0` |
| 策略 | 允许 |

⚠️ **不要图省事填 `0.0.0.0/0`** —— 指标里含 `channel` / `model` label，
而本项目的安全底线是「不外泄身份信息」。开放后任何人都能读全栈指标。

开通后访问：**`http://119.29.173.89:30909`**（Prometheus 原生 UI，含 PromQL 查询框）。

### 可直接用的查询（开通后粘进Prometheus UI 的 Execute 里）

```promql
# 工具错误按分类分布（#192 修复后应能看到 upstream_4xx / gate_blocked）
sum by (tool, error_class) (pi_runtime_tool_calls_total{result="error"})

# 工具调用总览
sum by (tool, result) (pi_runtime_tool_calls_total)

# LLM 上游错误（1.5-a 新增，stage 区分主轮/压缩）
sum by (stage, error_class, channel, model) (pi_runtime_llm_errors_total)

# 工具耗时 p99
histogram_quantile(0.99, sum by (le, tool) (rate(pi_runtime_tool_duration_seconds_bucket[5m])))

# 静默降级（阶段三未实现，当前无数据）
sum(increase(nest_gen_silent_degrade_total[5m]))
```

## 为什么不用 Ingress

Ingress 需要域名 + 证书 + 路由规则；「本机查看指标」只需一条直连路径。

## 为什么是 30909

宿主 **9090 已被 `pintuotuo-prometheus` 占用**（另一项目，docker compose，已对外暴露）。
k3s 的 NodePort 段（30000-32767）不冲突，选 30909 为可读性。

## 已知取舍

- **保留期 7 天 / size 上限 2GB**：磁盘只剩 7.8G（已用 81%），这是最该收的旋钮
- **不装 Grafana**：本阶段只要「指标活下来」；用原生 UI + PromQL
- **告警规则留空**：见 `rules/README.md`（阈值需 ≥1 个发布周期真实数据校准）
