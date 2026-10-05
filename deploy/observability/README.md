# 本目录各文件的**实际部署状态**（2026-10-06 实测）

**仓库里有文件 ≠ 线上跑着。** 本目录除 Prometheus 外全是**未启用的预留资产**，
且没有任何 CI 会 apply 这里的任何东西（全仓 `kubectl` / `k3s` / `KUBECONFIG` 零命中）。

线上实况（`kubectl -n pi-lnk-observability get cm,svc,sts` + 全集群 `grep grafana|tempo|otel`）：

| 文件 | 形态 | 线上状态 |
|---|---|---|
| `prometheus/prometheus-statefulset.yaml` | k8s 清单（StatefulSet + Service + ConfigMap 三合一） | ✅ **已部署**（NodePort 30909，ns `pi-lnk-observability`） |
| `prometheus/prometheus.yml` | 抓取配置（内嵌进上面的 ConfigMap） | ✅ 已生效 |
| `prometheus/rules/README.md` | 说明文档 | ✅ 生效（**规则刻意为空**，见该文件） |
| `prometheus/read-decisions.sh` | 诊断脚本（不改动任何状态） | ✅ 需手工执行，见该文件头 |
| `grafana/provisioning/datasources/datasources.yaml` | Grafana provisioning 片段 | ❌ **未部署**（全集群零 Grafana） |
| `otel-collector.yaml` | **不是 k8s 清单**（无 `apiVersion`）= compose 片段 | ❌ 未部署 |
| `tempo.yaml` | **不是 k8s 清单**（无 `apiVersion`）= compose 片段 | ❌ 未部署 |

## 为什么保留这些未部署文件

它们是 spec §7 后续阶段的资产（trace 链路：Nest/pi-runtime → OTel Collector → Tempo → Grafana）。
**删掉会丢失设计意图**，但留在仓库里不加标注，则会让任何人（包括未来的我）把
「文件存在」读成「服务在线」——而 `kubectl get deploy -A | grep tempo` 是零命中。

⇒ 规则：**判断某个观测组件是否在线，只认集群里的实际对象，不认本目录的文件。**

## 启用它们之前必须先回答（不是「读完文档就能开」）

1. **谁算**：Prometheus 已能算；Tempo 的 trace 聚合无采集端（pi-runtime 未接 OTLP）。
2. **发给谁**：Alertmanager 不存在（宿主 `pintuotuo-alertmanager` 属**另一项目**，不可复用）。
3. **在哪看**：Grafana 未部署；当前只能用 Prometheus 原生 UI。
4. **磁盘**：宿主已用 **85%**（40G 剩 6.2G）。Prometheus 当前上限 2GB / 7d；
   再加 Tempo + Grafana 之前必须先算清占用，否则会挤掉其他项目（`deploy.yml:187` 红线：
   `image prune -a` 会打断别人的容器）。
