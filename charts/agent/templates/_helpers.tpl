{{- define "agent.fullname" -}}
{{- "agent" -}}
{{- end -}}

{{- define "agent.labels" -}}
app.kubernetes.io/name: {{ include "agent.fullname" . }}
app.kubernetes.io/part-of: urumi
app.kubernetes.io/component: agent
{{- end -}}
