{{- define "keel-service-base.name" -}}
{{- .Chart.Name -}}
{{- end -}}

{{- define "keel-service-base.fullname" -}}
{{- printf "%s-%s" .Release.Name .Chart.Name | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "keel-service-base.labels" -}}
app.kubernetes.io/name: {{ include "keel-service-base.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end -}}

{{- define "keel-service-base.selectorLabels" -}}
app.kubernetes.io/name: {{ include "keel-service-base.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}
