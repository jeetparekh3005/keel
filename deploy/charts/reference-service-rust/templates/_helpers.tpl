{{- define "reference-service.name" -}}
{{- .Chart.Name -}}
{{- end -}}

{{- define "reference-service.fullname" -}}
{{- printf "%s-%s" .Release.Name .Chart.Name | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "reference-service.labels" -}}
app.kubernetes.io/name: {{ include "reference-service.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end -}}

{{- define "reference-service.selectorLabels" -}}
app.kubernetes.io/name: {{ include "reference-service.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}
