{{- define "gateway.fullname" -}}
{{- "gateway" -}}
{{- end -}}

{{- define "gateway.labels" -}}
app.kubernetes.io/name: {{ include "gateway.fullname" . }}
app.kubernetes.io/part-of: urumi
app.kubernetes.io/component: gateway
{{- end -}}

{{- define "gateway.postgresName" -}}
{{- "gateway-postgres" -}}
{{- end -}}

{{- define "gateway.postgresLabels" -}}
app.kubernetes.io/name: {{ include "gateway.postgresName" . }}
app.kubernetes.io/part-of: urumi
app.kubernetes.io/component: gateway-db
{{- end -}}

{{/*
Stable Postgres password: reuse the existing Secret's value on upgrade, only
generate a fresh one on first install. Without the lookup, every `helm upgrade`
would rotate the password and break the running gateway's connection.
*/}}
{{- define "gateway.postgresPassword" -}}
{{- $existing := lookup "v1" "Secret" .Release.Namespace "gateway-postgres" -}}
{{- if $existing -}}
{{- index $existing.data "POSTGRES_PASSWORD" | b64dec -}}
{{- else -}}
{{- randAlphaNum 24 -}}
{{- end -}}
{{- end -}}
