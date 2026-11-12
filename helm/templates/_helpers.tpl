{{/* Name of every object of the release. */}}
{{- define "trading.fullname" -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{/* Labels that select the Pods; never change them after the first install (selectors are immutable). */}}
{{- define "trading.selectorLabels" -}}
app.kubernetes.io/name: {{ .Chart.Name }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{/* Labels on every object. */}}
{{- define "trading.labels" -}}
{{ include "trading.selectorLabels" . }}
app.kubernetes.io/version: {{ .Values.image.tag | trunc 63 | trimSuffix "-" | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version }}
{{- end -}}

{{/* Restricted security context of every container. */}}
{{- define "trading.containerSecurityContext" -}}
allowPrivilegeEscalation: false
readOnlyRootFilesystem: true
capabilities:
  drop: ["ALL"]
{{- end -}}

{{/* Name of the ConfigMap with the runtime configuration file (kept apart from the environment ConfigMap). */}}
{{- define "trading.runtimeConfigMap" -}}
{{ include "trading.fullname" . }}-runtime
{{- end -}}

{{/* The directory the runtime ConfigMap is mounted at, and the file in it that RUNTIME_CONFIG_FILE names. */}}
{{- define "trading.runtimeDir" -}}
/etc/trading/runtime
{{- end -}}

{{- define "trading.runtimeFile" -}}
{{ include "trading.runtimeDir" . }}/runtime.env
{{- end -}}

{{/* The three API ports must differ: the NetworkPolicy admits different callers to each (the service refuses to start too). */}}
{{- define "trading.checkPorts" -}}
{{- $ports := list (int .Values.service.port) (int .Values.service.internalPort) (int .Values.service.grpcPort) -}}
{{- if ne (len $ports) (len (uniq $ports)) -}}
{{- fail "service.port, service.internalPort and service.grpcPort must differ: the NetworkPolicy admits other callers to each" -}}
{{- end -}}
{{- if has (int .Values.metrics.port) $ports -}}
{{- fail "metrics.port must differ from service.port, service.internalPort and service.grpcPort: no API port serves /metrics" -}}
{{- end -}}
{{- end -}}

{{/* The three client ids of the internal port must differ, as the service insists at start (the schema cannot compare keys). */}}
{{- define "trading.checkClientIds" -}}
{{- $env := .Values.env -}}
{{- $ids := list (default "markets" (trim (default "" $env.MARKETS_CLIENT_ID))) (default "payments" (trim (default "" $env.PAYMENTS_CLIENT_ID))) (default "market-maker" (trim (default "" $env.MARKET_MAKER_CLIENT_ID))) -}}
{{- if ne (len $ids) (len (uniq $ids)) -}}
{{- fail "env.MARKETS_CLIENT_ID, env.PAYMENTS_CLIENT_ID and env.MARKET_MAKER_CLIENT_ID must differ: each internal endpoint admits exactly one client" -}}
{{- end -}}
{{- end -}}
