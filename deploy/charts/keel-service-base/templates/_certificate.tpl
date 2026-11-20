{{/*
Per-service mTLS Certificate (ADR-0027), OPT-IN and default OFF.

When `mtls.enabled` is true this renders a cert-manager Certificate whose renewal
cert-manager drives in-cluster: issuerRef -> the OpenBao-backed ClusterIssuer,
secretName -> the TLS Secret the pod mounts, dnsNames -> the service's in-cluster
names, short `duration` + `renewBefore` so it rotates ahead of expiry. The
existing mtls_*_credentials builders consume tls.crt/tls.key/ca.crt from the
mounted Secret unchanged.

When disabled this define yields the empty string, so a chart with the feature off
renders byte-identically to before it existed.
*/}}
{{- define "keel-service-base.certificate" -}}
{{- $mtls := .Values.mtls | default dict -}}
{{- if $mtls.enabled -}}
{{- $issuer := $mtls.issuerRef | default dict -}}
apiVersion: cert-manager.io/v1
kind: Certificate
metadata:
  name: {{ printf "%s-mtls" (include "keel-service-base.fullname" .) }}
  labels:
    {{- include "keel-service-base.labels" . | nindent 4 }}
spec:
  secretName: {{ include "keel-service-base.mtls.secretName" . }}
  # Short-lived + renew ahead of expiry: cert-manager rotates automatically.
  duration: {{ $mtls.duration | default "24h" }}
  renewBefore: {{ $mtls.renewBefore | default "8h" }}
  privateKey:
    algorithm: ECDSA
    size: 256
    rotationPolicy: Always
  # mTLS is bidirectional: both EKUs (the OpenBao role sets server + client auth).
  usages:
    - server auth
    - client auth
  commonName: {{ printf "%s.%s.svc.cluster.local" (include "keel-service-base.fullname" .) .Release.Namespace }}
  dnsNames:
    {{- if $mtls.dnsNames }}
    {{- toYaml $mtls.dnsNames | nindent 4 }}
    {{- else }}
    - {{ printf "%s.%s.svc" (include "keel-service-base.fullname" .) .Release.Namespace }}
    - {{ printf "%s.%s.svc.cluster.local" (include "keel-service-base.fullname" .) .Release.Namespace }}
    {{- end }}
  issuerRef:
    name: {{ $issuer.name | default "openbao-pki" }}
    kind: {{ $issuer.kind | default "ClusterIssuer" }}
    group: {{ $issuer.group | default "cert-manager.io" }}
{{- end -}}
{{- end -}}
