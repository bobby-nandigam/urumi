{{/* Base name for this store release, e.g. "store-default" */}}
{{- define "store.fullname" -}}
{{- printf "store-%s" .Values.storeId | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "store.labels" -}}
app.kubernetes.io/part-of: urumi
app.kubernetes.io/managed-by: {{ .Release.Service }}
urumi.store/id: {{ .Values.storeId | quote }}
{{- end -}}

{{/* Internal DB host (Service name) */}}
{{- define "store.dbHost" -}}
{{ include "store.fullname" . }}-mariadb
{{- end -}}

{{/* Internal WordPress Service host */}}
{{- define "store.wpHost" -}}
{{ include "store.fullname" . }}-wordpress
{{- end -}}
