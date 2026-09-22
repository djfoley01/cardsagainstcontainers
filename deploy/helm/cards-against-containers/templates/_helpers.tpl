{{/*
Configuration guards.

These MUST live inside a define and be included from a rendered template.
Helm only registers define blocks from _*.tpl partials — top-level actions in
a partial never execute, so a bare `fail` here would be silently dead code and
the checks below would protect nothing.
*/}}
{{- define "cac.validate" -}}
{{- if gt (int .Values.replicaCount) 1 -}}
{{- fail "cards-against-containers must run a single replica: all game rooms live in the pod's memory, so a second replica silently splits players across two different games with no error shown to anyone. Scaling out requires moving room state into Redis first." -}}
{{- end -}}
{{- if and .Values.route.enabled .Values.ingress.enabled -}}
{{- fail "enable either route (OpenShift) or ingress (plain Kubernetes), not both" -}}
{{- end -}}
{{- if lt (int .Values.containerPort) 1024 -}}
{{- fail "containerPort must be 1024 or above: the container runs as a non-root user and cannot bind a privileged port, so the process would die with EACCES" -}}
{{- end -}}
{{- if and .Values.customDecks.configMap .Values.customDecks.persistentVolumeClaim -}}
{{- fail "customDecks: set either configMap or persistentVolumeClaim, not both — they would mount over each other at the same path" -}}
{{- end -}}
{{- range .Values.extraEnv -}}
{{- if or (eq .name "PORT") (eq .name "HOST") (eq .name "CAC_DECK_DIRS") -}}
{{- fail "set containerPort (or customDecks.mountPath) instead of overriding PORT, HOST or CAC_DECK_DIRS through extraEnv: the declared containerPort and the probes are derived from it, and overriding the variable alone leaves them pointing at a port nothing is listening on, so the pod restarts forever" -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{- define "cac.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "cac.fullname" -}}
{{- if .Values.fullnameOverride -}}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- $name := default .Chart.Name .Values.nameOverride -}}
{{- if contains $name .Release.Name -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{- define "cac.labels" -}}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{ include "cac.selectorLabels" . }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end -}}

{{- define "cac.selectorLabels" -}}
app.kubernetes.io/name: {{ include "cac.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{- define "cac.serviceAccountName" -}}
{{- if .Values.serviceAccount.create -}}
{{- default (include "cac.fullname" .) .Values.serviceAccount.name -}}
{{- else -}}
{{- default "default" .Values.serviceAccount.name -}}
{{- end -}}
{{- end -}}

{{- define "cac.image" -}}
{{- printf "%s:%s" .Values.image.repository (default .Chart.AppVersion .Values.image.tag) -}}
{{- end -}}
