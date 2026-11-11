{{- define "keel-service-base.poddisruptionbudget" -}}
{{- if and .Values.podDisruptionBudget.enabled (gt (int .Values.replicaCount) 1) }}
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: {{ include "keel-service-base.fullname" . }}
  labels:
    {{- include "keel-service-base.labels" . | nindent 4 }}
spec:
  minAvailable: {{ .Values.podDisruptionBudget.minAvailable }}
  selector:
    matchLabels:
      {{- include "keel-service-base.selectorLabels" . | nindent 6 }}
{{- end }}
{{- end -}}
