{{- define "keel-service-base.service" -}}
apiVersion: v1
kind: Service
metadata:
  name: {{ include "keel-service-base.fullname" . }}
  labels:
    {{- include "keel-service-base.labels" . | nindent 4 }}
spec:
  type: ClusterIP
  selector:
    {{- include "keel-service-base.selectorLabels" . | nindent 4 }}
  ports:
    - name: http
      port: {{ .Values.service.port }}
      targetPort: http
      protocol: TCP
{{- end -}}
