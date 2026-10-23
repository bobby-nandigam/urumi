{{- define "woomcp.fullname" -}}
{{- printf "woo-mcp-%s" .Values.storeId | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "woomcp.labels" -}}
app.kubernetes.io/name: {{ include "woomcp.fullname" . }}
app.kubernetes.io/part-of: urumi
app.kubernetes.io/component: woo-mcp
urumi.store/id: {{ .Values.storeId | quote }}
{{- end -}}
