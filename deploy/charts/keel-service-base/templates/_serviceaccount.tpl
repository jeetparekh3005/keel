{{- define "keel-service-base.serviceaccount" -}}
apiVersion: v1
kind: ServiceAccount
metadata:
  name: {{ include "keel-service-base.fullname" . }}
  labels:
    {{- include "keel-service-base.labels" . | nindent 4 }}
# The service calls no Kubernetes API; do not mount a token.
automountServiceAccountToken: false
{{- end -}}
