{{/*
pi-lnk-runtime Helm helpers（自包含，Day-1 不引 bitnami/common —— 单服务 chart
无子 chart 依赖，自写 helpers 反而减少一层供应链；偏离 spec §5.2.2 已在 README 记录）
*/}}
{{- define "pi-lnk-runtime.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "pi-lnk-runtime.fullname" -}}
{{- if .Values.fullnameOverride -}}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s" (include "pi-lnk-runtime.name" .) | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}

{{- define "pi-lnk-runtime.labels" -}}
app.kubernetes.io/name: {{ include "pi-lnk-runtime.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
app: pi-runtime
tier: runtime
env: {{ .Values.envClass | default "dev" }}
{{- end -}}

{{- define "pi-lnk-runtime.serviceAccountName" -}}
{{- default (include "pi-lnk-runtime.fullname" .) .Values.serviceAccount.name -}}
{{- end -}}
