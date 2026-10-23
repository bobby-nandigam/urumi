{{- define "utilsmcp.fullname" -}}
{{- printf "utils-mcp-%s" .Values.instance | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "utilsmcp.labels" -}}
app.kubernetes.io/name: {{ include "utilsmcp.fullname" . }}
app.kubernetes.io/part-of: urumi
app.kubernetes.io/component: utils-mcp
urumi.utils/instance: {{ .Values.instance | quote }}
{{- end -}}
