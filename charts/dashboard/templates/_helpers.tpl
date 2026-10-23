{{- define "dashboard.fullname" -}}
{{- "dashboard" -}}
{{- end -}}

{{- define "dashboard.labels" -}}
app.kubernetes.io/name: {{ include "dashboard.fullname" . }}
app.kubernetes.io/part-of: urumi
app.kubernetes.io/component: dashboard
{{- end -}}
