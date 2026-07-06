# AAFP Production Deployment Guide

**Date:** 2026-07-04
**Status:** Reference guide for deploying AAFP agents to production
**Audience:** Platform engineers, SREs, DevOps teams operating AAFP infrastructure

---

## Table of Contents

1. [Architecture Overview](#1-architecture-overview)
2. [Container Image Strategy](#2-container-image-strategy)
3. [Kubernetes Deployment Patterns](#3-kubernetes-deployment-patterns)
4. [Helm Chart Design](#4-helm-chart-design)
5. [TLS Certificate Management for ML-DSA-65](#5-tls-certificate-management-for-ml-dsa-65)
6. [Secrets Management](#6-secrets-management)
7. [Health Checking and Liveness Probes](#7-health-checking-and-liveness-probes)
8. [Graceful Shutdown and Connection Draining](#8-graceful-shutdown-and-connection-draining)
9. [Blue/Green Deployment for Agent Upgrades](#9-bluegreen-deployment-for-agent-upgrades)
10. [Resource Limits and Tuning](#10-resource-limits-and-tuning)
11. [Monitoring Stack Integration](#11-monitoring-stack-integration)
12. [Log Aggregation and Tracing](#12-log-aggregation-and-tracing)
13. [Network and NAT Considerations](#13-network-and-nat-considerations)
14. [Production Checklist](#14-production-checklist)

---

## 1. Architecture Overview

AAFP agents are QUIC-native processes that combine transport, identity, discovery,
and application-layer messaging into a single binary. The production deployment
model treats each agent as a long-running stateful pod with:

- **QUIC/UDP transport** on port 4433 (not TCP — QUIC runs over UDP)
- **Prometheus metrics** on a separate TCP port (default 9090)
- **Persistent identity** via ML-DSA-65 keypair stored as a Kubernetes Secret
- **DHT participation** with ephemeral routing tables (emptyDir volume)
- **NAT traversal** via bootstrap relays for cross-cluster connectivity

### Deployment topology

```
                    ┌──────────────────────────────────┐
                    │         Kubernetes Cluster         │
                    │                                    │
                    │  ┌─────────┐  ┌─────────┐         │
                    │  │ Agent   │  │ Agent   │  ...     │
                    │  │ Pod 1   │  │ Pod 2   │         │
                    │  │ :4433/  │  │ :4433/  │         │
                    │  │  udp    │  │  udp    │         │
                    │  │ :9090   │  │ :9090   │         │
                    │  │  tcp    │  │  tcp    │         │
                    │  └────┬────┘  └────┬────┘         │
                    │       │            │               │
                    │  ┌────┴────────────┴────────────┐  │
                    │  │     Service (ClusterIP)       │  │
                    │  │     UDP:4433  TCP:9090        │  │
                    │  └───────────────┬───────────────┘  │
                    │                  │                  │
                    └──────────────────┼──────────────────┘
                                       │
                              ┌────────┴────────┐
                              │  Bootstrap Relay │
                              │  (public IP)     │
                              │  quic://relay    │
                              └─────────────────┘
```

### Key design decisions

| Decision | Rationale |
|----------|-----------|
| UDP-first (QUIC) | AAFP uses QUIC over UDP, not TCP. Services, load balancers, and firewalls must allow UDP 4433. |
| Separate metrics port | Prometheus scrapes TCP `/metrics`; QUIC port stays UDP-only. Avoids protocol confusion. |
| Identity as Secret | ML-DSA-65 keypair (4032-byte secret + 1952-byte public) is the agent's root identity. Must persist across pod restarts. |
| DHT as emptyDir | Routing tables are reconstructable from the network. No need for persistent volumes — reduces operational complexity. |
| Relay as separate deployment | Relays need public IPs and stable endpoints. Agents behind NAT discover and use them. |

---

## 2. Container Image Strategy

### Multi-stage Dockerfile

The production Dockerfile uses a two-stage build: `rust:1.85-slim` for compilation
and `gcr.io/distroless/cc-debian12:nonroot` for the runtime. Distroless eliminates
shell access (reducing attack surface) while the `nonroot` variant runs as UID 65532.

```dockerfile
# ── Builder ──────────────────────────────────────────────────────────────────
FROM rust:1.85-slim AS builder

WORKDIR /build

# Install build dependencies for aws-lc-rs (PQ crypto backend)
RUN apt-get update && apt-get install -y --no-install-recommends \
    protobuf-compiler \
    pkg-config \
    libssl-dev \
    ca-certificates \
    make \
    cmake \
    && rm -rf /var/lib/apt/lists/*

# Copy workspace manifest files first (for Docker layer caching)
COPY Cargo.toml Cargo.lock ./
COPY crates/ ./crates/

# Build release binary with CPU-specific optimizations
# RUSTFLAGS enables LTO and codegen optimizations for smaller binary
ENV RUSTFLAGS="-C link-arg=-s -C codegen-units=1 -C lto=fat"
RUN cargo build --release -p aafp-cli && \
    strip target/release/aafp-agent

# ── Runtime ──────────────────────────────────────────────────────────────────
FROM gcr.io/distroless/cc-debian12:nonroot

WORKDIR /app

# Copy the binary from the builder stage
COPY --from=builder /build/target/release/aafp-agent /aafp-agent

# Expose QUIC transport port (UDP) and Prometheus metrics port (TCP)
EXPOSE 4433/udp
EXPOSE 9090/tcp

# Environment defaults
ENV AAFP_BIND=0.0.0.0:4433
ENV AAFP_METRICS=0.0.0.0:9090
ENV RUST_LOG=info
ENV AAFP_DATA_DIR=/data

# Volume for persistent data (keys mounted from Secret, DHT from emptyDir)
VOLUME ["/data"]

# Health check — exec-based (no shell in distroless)
HEALTHCHECK --interval=30s --timeout=5s --retries=3 --start-period=10s \
  CMD ["/aafp-agent", "health"]

# Run as nonroot user (distroless default: UID 65532)
ENTRYPOINT ["/aafp-agent"]
CMD ["serve"]
```

### Image build and tagging

```bash
# Build with buildkit for better caching
DOCKER_BUILDKIT=1 docker build \
  -t registry.example.com/aafp-agent:v0.1.0 \
  -t registry.example.com/aafp-agent:latest \
  -f implementations/rust/Dockerfile \
  implementations/rust/

# Push to registry
docker push registry.example.com/aafp-agent:v0.1.0
docker push registry.example.com/aafp-agent:latest

# Verify image size (should be < 30MB for distroless)
docker images registry.example.com/aafp-agent:v0.1.0
```

### Image hardening notes

- **No shell**: Distroless `cc-debian12` has no `/bin/sh`. All `exec` probes
  must call the binary directly (`["/aafp-agent", "health"]`), not `["sh", "-c", "..."]`.
- **Non-root**: Runs as UID 65532. The `CAP_NET_BIND_SERVICE` capability is
  needed only if binding to ports < 1024. Port 4433 does not require it.
- **Read-only root filesystem**: Set `readOnlyRootFilesystem: true` in the pod
  security context. The `/data` volume is writable (emptyDir) for DHT state.
- **No package manager**: Distroless has no `apt`, `apk`, or `yum`. Security
  patches require rebuilding the image with an updated base.

---

## 3. Kubernetes Deployment Patterns

### Core manifest

The existing `deploy/kubernetes/aafp-agent.yaml` provides a baseline. The
production version below adds security contexts, resource limits, and
UDP-specific Service configuration.

```yaml
---
# ── ConfigMap ────────────────────────────────────────────────────────────────
apiVersion: v1
kind: ConfigMap
metadata:
  name: aafp-agent-config
  labels:
    app: aafp-agent
data:
  AAFP_BIND: "0.0.0.0:4433"
  AAFP_METRICS: "0.0.0.0:9090"
  AAFP_CAPABILITIES: "inference,translation"
  AAFP_RELAY: "quic://aafp-relay:4433"
  RUST_LOG: "info,aafp_sdk=debug"
  AAFP_DATA_DIR: "/data"

---
# ── Secret (agent keypair) ───────────────────────────────────────────────────
# Generate the keypair locally, then base64-encode for the Secret:
#   aafp init --output agent.key --capabilities inference
#   kubectl create secret generic aafp-agent-key \
#     --from-file=agent.key=agent.key
apiVersion: v1
kind: Secret
metadata:
  name: aafp-agent-key
  labels:
    app: aafp-agent
type: Opaque
data:
  agent.key: ""  # Base64-encoded keypair — REPLACE with actual key

---
# ── Deployment ───────────────────────────────────────────────────────────────
apiVersion: apps/v1
kind: Deployment
metadata:
  name: aafp-agent
  labels:
    app: aafp-agent
spec:
  replicas: 3
  selector:
    matchLabels:
      app: aafp-agent
  strategy:
    type: RollingUpdate
    rollingUpdate:
      maxUnavailable: 0
      maxSurge: 1
  template:
    metadata:
      labels:
        app: aafp-agent
      annotations:
        prometheus.io/scrape: "true"
        prometheus.io/port: "9090"
        prometheus.io/path: "/metrics"
    spec:
      terminationGracePeriodSeconds: 60
      securityContext:
        runAsNonRoot: true
        runAsUser: 65532
        runAsGroup: 65532
        fsGroup: 65532
      containers:
        - name: aafp-agent
          image: registry.example.com/aafp-agent:v0.1.0
          imagePullPolicy: IfNotPresent
          ports:
            - containerPort: 4433
              protocol: UDP
              name: quic
            - containerPort: 9090
              protocol: TCP
              name: metrics
          envFrom:
            - configMapRef:
                name: aafp-agent-config
          resources:
            requests:
              cpu: 250m
              memory: 128Mi
            limits:
              cpu: 1000m
              memory: 512Mi
          volumeMounts:
            - name: keys
              mountPath: /data/keys
              readOnly: true
            - name: dht
              mountPath: /data/dht
          livenessProbe:
            exec:
              command: ["/aafp-agent", "health"]
            initialDelaySeconds: 10
            periodSeconds: 30
            timeoutSeconds: 5
            failureThreshold: 3
          readinessProbe:
            exec:
              command: ["/aafp-agent", "health"]
            initialDelaySeconds: 5
            periodSeconds: 10
            timeoutSeconds: 3
            failureThreshold: 2
          startupProbe:
            exec:
              command: ["/aafp-agent", "health"]
            periodSeconds: 5
            failureThreshold: 12
          securityContext:
            runAsNonRoot: true
            runAsUser: 65532
            allowPrivilegeEscalation: false
            readOnlyRootFilesystem: true
            capabilities:
              drop:
                - ALL
              add:
                - NET_BIND_SERVICE  # only if binding < 1024
      volumes:
        - name: keys
          secret:
            secretName: aafp-agent-key
            defaultMode: 0400
        - name: dht
          emptyDir:
            sizeLimit: 100Mi

---
# ── Service (UDP for QUIC + TCP for metrics) ─────────────────────────────────
apiVersion: v1
kind: Service
metadata:
  name: aafp-agent
  labels:
    app: aafp-agent
spec:
  type: ClusterIP
  selector:
    app: aafp-agent
  ports:
    - port: 4433
      targetPort: 4433
      protocol: UDP
      name: quic
    - port: 9090
      targetPort: 9090
      protocol: TCP
      name: metrics

---
# ── Pod Disruption Budget ────────────────────────────────────────────────────
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: aafp-agent-pdb
  labels:
    app: aafp-agent
spec:
  minAvailable: 2
  selector:
    matchLabels:
      app: aafp-agent

---
# ── Horizontal Pod Autoscaler ────────────────────────────────────────────────
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: aafp-agent-hpa
  labels:
    app: aafp-agent
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: aafp-agent
  minReplicas: 3
  maxReplicas: 20
  metrics:
    - type: Resource
      resource:
        name: cpu
        target:
          type: Utilization
          averageUtilization: 70
    - type: Resource
      resource:
        name: memory
        target:
          type: Utilization
          averageUtilization: 80
  behavior:
    scaleUp:
      stabilizationWindowSeconds: 30
      policies:
        - type: Pods
          value: 2
          periodSeconds: 60
    scaleDown:
      stabilizationWindowSeconds: 300
      policies:
        - type: Pods
          value: 1
          periodSeconds: 120
```

### UDP load balancing caveats

Kubernetes `ClusterIP` Services load-balance UDP datagrams per-flow (5-tuple).
QUIC connection IDs (CIDs) allow the client to choose a flow that maps to a
specific backend pod. However, if a pod restarts, its CID mapping is lost.

**Recommendation:** For intra-cluster agent-to-agent traffic, use a `headless`
Service so clients resolve directly to pod IPs, bypassing kube-proxy's UDP
load balancing entirely:

```yaml
apiVersion: v1
kind: Service
metadata:
  name: aafp-agent-headless
  labels:
    app: aafp-agent
spec:
  clusterIP: None  # headless — returns pod IPs via DNS
  selector:
    app: aafp-agent
  ports:
    - port: 4433
      targetPort: 4433
      protocol: UDP
      name: quic
```

With a headless Service, `aafp-agent-headless.namespace.svc.cluster.local`
resolves to the set of pod IPs. Agents can use DNS-based discovery to find
peers within the cluster.

---

## 4. Helm Chart Design

### Chart structure

```
aafp-agent/
├── Chart.yaml
├── values.yaml
├── values-production.yaml
├── templates/
│   ├── _helpers.tpl
│   ├── configmap.yaml
│   ├── secret.yaml
│   ├── deployment.yaml
│   ├── service.yaml
│   ├── hpa.yaml
│   ├── pdb.yaml
│   ├── servicemonitor.yaml
│   ├── networkpolicy.yaml
│   └── NOTES.txt
```

### Chart.yaml

```yaml
apiVersion: v2
name: aafp-agent
description: AAFP agent deployment for agent-to-agent networking
type: application
version: 0.1.0
appVersion: "0.1.0"
keywords:
  - aafp
  - agent
  - quic
  - post-quantum
maintainers:
  - name: AAFP Team
```

### values.yaml (defaults)

```yaml
# ── Image ────────────────────────────────────────────────────────────────────
image:
  repository: registry.example.com/aafp-agent
  tag: "0.1.0"
  pullPolicy: IfNotPresent
  pullSecrets: []

# ── Agent configuration ──────────────────────────────────────────────────────
agent:
  bind: "0.0.0.0:4433"
  metrics: "0.0.0.0:9090"
  capabilities:
    - inference
    - translation
  relay: "quic://aafp-relay:4433"
  dataDir: "/data"
  logLevel: "info"

# ── Identity ─────────────────────────────────────────────────────────────────
identity:
  # Existing secret containing agent.key (base64-encoded keypair)
  existingSecret: ""
  # If no existing secret, one will be generated on first install
  autoGenerate: true
  # Path inside the container where the key is mounted
  keyPath: "/data/keys/agent.key"

# ── Deployment ───────────────────────────────────────────────────────────────
replicaCount: 3

resources:
  requests:
    cpu: 250m
    memory: 128Mi
  limits:
    cpu: 1000m
    memory: 512Mi

# ── Autoscaling ──────────────────────────────────────────────────────────────
autoscaling:
  enabled: true
  minReplicas: 3
  maxReplicas: 20
  targetCPUUtilizationPercentage: 70
  targetMemoryUtilizationPercentage: 80
  scaleUpStabilizationWindowSeconds: 30
  scaleDownStabilizationWindowSeconds: 300

# ── Pod disruption budget ────────────────────────────────────────────────────
podDisruptionBudget:
  enabled: true
  minAvailable: 2

# ── Service ──────────────────────────────────────────────────────────────────
service:
  type: ClusterIP
  # Headless service for direct pod-to-pod QUIC (bypasses UDP LB issues)
  headless: false
  quicPort: 4433
  metricsPort: 9090

# ── Probes ───────────────────────────────────────────────────────────────────
probes:
  liveness:
    enabled: true
    initialDelaySeconds: 10
    periodSeconds: 30
    timeoutSeconds: 5
    failureThreshold: 3
  readiness:
    enabled: true
    initialDelaySeconds: 5
    periodSeconds: 10
    timeoutSeconds: 3
    failureThreshold: 2
  startup:
    enabled: true
    periodSeconds: 5
    failureThreshold: 12

# ── Graceful shutdown ────────────────────────────────────────────────────────
terminationGracePeriodSeconds: 60

# ── Security ─────────────────────────────────────────────────────────────────
podSecurityContext:
  runAsNonRoot: true
  runAsUser: 65532
  runAsGroup: 65532
  fsGroup: 65532

containerSecurityContext:
  runAsNonRoot: true
  runAsUser: 65532
  allowPrivilegeEscalation: false
  readOnlyRootFilesystem: true
  capabilities:
    drop:
      - ALL

# ── Monitoring ───────────────────────────────────────────────────────────────
monitoring:
  prometheus:
    enabled: true
    serviceMonitor:
      enabled: true
      namespace: monitoring
      interval: 5s
      scrapeTimeout: 3s
  grafana:
    dashboard:
      enabled: true
      configMapName: aafp-dashboard

# ── Network policy ───────────────────────────────────────────────────────────
networkPolicy:
  enabled: true
  # Allow ingress from other AAFP agents and Prometheus
  ingressFromAgents: true
  ingressFromPrometheus: true

# ── Node selector / tolerations ──────────────────────────────────────────────
nodeSelector: {}
tolerations: []
affinity: {}
```

### values-production.yaml (overrides)

```yaml
image:
  tag: "0.1.0"
  pullPolicy: IfNotPresent

agent:
  logLevel: "info,aafp_sdk=warn,aafp_transport_quic=warn"

replicaCount: 5

resources:
  requests:
    cpu: 500m
    memory: 256Mi
  limits:
    cpu: 2000m
    memory: 1Gi

autoscaling:
  minReplicas: 5
  maxReplicas: 50

podDisruptionBudget:
  minAvailable: 3

terminationGracePeriodSeconds: 90

service:
  headless: true  # production: bypass UDP load balancing

networkPolicy:
  enabled: true
```

### _helpers.tpl

```yaml
{{/* Generate the full image reference */}}
{{- define "aafp-agent.image" -}}
{{- .Values.image.repository }}:{{ .Values.image.tag | default .Chart.AppVersion }}
{{- end }}

{{/* Common labels */}}
{{- define "aafp-agent.labels" -}}
app.kubernetes.io/name: aafp-agent
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{/* Selector labels */}}
{{- define "aafp-agent.selectorLabels" -}}
app: aafp-agent
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}
```

### Install and upgrade

```bash
# Install with production values
helm install aafp-agent ./aafp-agent \
  -f values-production.yaml \
  -n aafp --create-namespace

# Upgrade (rolling update)
helm upgrade aafp-agent ./aafp-agent \
  -f values-production.yaml \
  -n aafp

# Rollback if needed
helm rollback aafp-agent 1 -n aafp

# View deployed resources
helm get manifest aafp-agent -n aafp | kubectl apply --dry-run=client -f -
```

---

## 5. TLS Certificate Management for ML-DSA-65

### Two-layer certificate model

AAFP uses a **two-layer** identity and transport model:

| Layer | Algorithm | Purpose | Where |
|-------|-----------|---------|-------|
| Transport (TLS) | Ed25519 self-signed + X25519MLKEM768 KEX | QUIC connection encryption | `QuicConfig` / `TlsIdentity` |
| Application (identity) | ML-DSA-65 (FIPS 204) | Agent identity, handshake signatures, UCAN | `AgentKeypair` |

The transport layer uses self-signed Ed25519 certificates generated at startup
by `generate_self_signed_cert()` in `aafp-transport-quic/src/config.rs`. This is
intentional: rustls does not yet support ML-DSA-65 in certificate verification,
so agent identity authentication happens at the application layer via the AAFP
v1 handshake (`drive_client_handshake` / `drive_server_handshake`).

The PQ KEX (X25519MLKEM768 hybrid) still protects the transport layer against
harvest-now-decrypt-later attacks. This is enabled by default (`enable_pq: true`
in `QuicConfig`).

### ML-DSA-65 keypair characteristics

From `aafp-identity/src/keypair.rs`:

| Component | Size |
|-----------|------|
| Public key | 1952 bytes |
| Secret key | 4032 bytes |
| Signature | 3309 bytes |
| AgentId (SHA-256 of public key) | 32 bytes |

The keypair is serialized as `u32_be(secret_len) || secret || public` via
`AgentKeypair::to_bytes()`. Total serialized size: ~5988 bytes.

### Certificate lifecycle in production

```
1. Generate keypair (offline, once per agent)
   aafp init --output agent.key --capabilities inference

2. Store as Kubernetes Secret
   kubectl create secret generic aafp-agent-key \
     --from-file=agent.key=agent.key

3. Mount read-only in pod
   /data/keys/agent.key (mode 0400)

4. Agent loads keypair at startup
   AgentKeypair::from_secret_and_public()

5. Key rotation (RFC 0011 §6)
   - Generate new keypair
   - Create KeyRotationRecord (old key signs new key)
   - Publish rotation record to DHT
   - Revoke old key via RevocationList
   - Update Kubernetes Secret
```

### Key rotation procedure

The `KeyRotationRecord` (in `aafp-identity/src/key_rotation.rs`) proves
continuity of identity across key changes. Both the old and new keys sign the
same data, proving the old key authorized the rotation and the new key is
controlled by the same entity.

```bash
# 1. Generate new keypair (on a secure workstation)
aafp init --output agent-new.key --capabilities inference

# 2. Create rotation record (old key signs new key)
# This is done programmatically:
#   KeyRotationRecord::new(old_id, new_id, &new_pk, timestamp,
#                          &old_sk, &new_sk)
# The record is published to the DHT so peers can verify continuity.

# 3. Revoke old key
#   record.revoke_old_key(&old_sk, Some("scheduled rotation".into()))
#   record.create_revocation_crl(&old_sk, 3600, None)

# 4. Update Kubernetes Secret
kubectl create secret generic aafp-agent-key \
  --from-file=agent.key=agent-new.key \
  --dry-run=client -o yaml | kubectl apply -f -

# 5. Rolling restart to pick up new key
kubectl rollout restart deployment/aafp-agent

# 6. Verify rotation
kubectl rollout status deployment/aafp-agent
```

### Rotation policy recommendations

| Parameter | Value | Rationale |
|-----------|-------|-----------|
| Rotation interval | 90 days | ML-DSA-65 is new; conservative rotation reduces risk of undetected compromise. |
| Rotation window | 24 hours | Old key remains valid for 24h after rotation to allow peers to learn the new key. |
| Revocation TTL | 7 days | CRL entries expire after 7 days; old key is considered fully revoked after that. |
| Emergency rotation | Immediate | On suspected compromise, rotate immediately and revoke with reason "compromise". |

---

## 6. Secrets Management

### Keypair storage

The ML-DSA-65 keypair is the agent's root identity. It must be:

1. **Generated offline** — never inside a container (containers are ephemeral)
2. **Stored as a Kubernetes Secret** — base64-encoded, mounted read-only
3. **Access-controlled** — only the agent pod's service account can read it

```yaml
# Secret with strict access control
apiVersion: v1
kind: Secret
metadata:
  name: aafp-agent-key
  labels:
    app: aafp-agent
  annotations:
    # Mark for external secrets operator sync (if using ESO)
    replicator.v1.mittwald.de/replicate-to: "aafp-prod,aafp-staging"
type: Opaque
data:
  agent.key: <base64-encoded keypair>
---
# Service account with minimal RBAC
apiVersion: v1
kind: ServiceAccount
metadata:
  name: aafp-agent
  labels:
    app: aafp-agent
automountServiceAccountToken: false
---
# RBAC — agent only needs to read its own secret
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: aafp-agent-secret-reader
rules:
  - apiGroups: [""]
    resources: ["secrets"]
    resourceNames: ["aafp-agent-key"]
    verbs: ["get"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: aafp-agent-secret-reader
subjects:
  - kind: ServiceAccount
    name: aafp-agent
roleRef:
  kind: Role
  name: aafp-agent-secret-reader
  apiGroup: rbac.authorization.k8s.io
```

### External secrets integration

For production, use External Secrets Operator (ESO) to sync keypairs from a
managed secrets store (AWS Secrets Manager, HashiCorp Vault, GCP Secret Manager):

```yaml
# ExternalSecret — syncs from AWS Secrets Manager
apiVersion: external-secrets.io/v1beta1
kind: ExternalSecret
metadata:
  name: aafp-agent-key
spec:
  refreshInterval: 1h
  secretStoreRef:
    name: aws-secrets-manager
    kind: ClusterSecretStore
  target:
    name: aafp-agent-key
    creationPolicy: Owner
  data:
    - secretKey: agent.key
      remoteRef:
        key: aafp/prod/agent-keypair
        property: keypair
```

### Vault integration (alternative)

```yaml
apiVersion: external-secrets.io/v1beta1
kind: ExternalSecret
metadata:
  name: aafp-agent-key
spec:
  refreshInterval: 1h
  secretStoreRef:
    name: vault-backend
    kind: SecretStore
  target:
    name: aafp-agent-key
    creationPolicy: Owner
  data:
    - secretKey: agent.key
      remoteRef:
        key: secret/aafp/prod/agent-keypair
        property: keypair
```

### Secrets rotation workflow

```
┌──────────────────┐     ┌──────────────────┐     ┌──────────────────┐
│  Vault / AWS SM  │────▶│  ExternalSecret  │────▶│  Kubernetes      │
│  (source of      │     │  Operator syncs  │     │  Secret          │
│   truth)         │     │  every 1h        │     │  (aafp-agent-key)│
└──────────────────┘     └──────────────────┘     └────────┬─────────┘
                                                            │
                                                  mountPath: /data/keys/agent.key
                                                            │
                                                  ┌────────┴─────────┐
                                                  │  Agent Pod       │
                                                  │  loads keypair   │
                                                  │  at startup      │
                                                  └──────────────────┘
```

**Rotation steps:**

1. Update the keypair in Vault / AWS Secrets Manager
2. ESO detects the change within `refreshInterval` (1h)
3. ESO updates the Kubernetes Secret
4. Trigger a rolling restart: `kubectl rollout restart deployment/aafp-agent`
5. New pods load the updated keypair; old pods drain and terminate

---

## 7. Health Checking and Liveness Probes

### Health status model

The SDK provides a three-level health status (`HealthStatus` in
`aafp-sdk/src/metrics.rs`):

| Status | Condition | Exit Code |
|--------|-----------|-----------|
| `Healthy` | Has connections, error rate < 10%, handshake failure rate < 30% | 0 |
| `Degraded` | Error rate > 10%, or handshake failure rate > 30%, or < 1 connection after 60s uptime | 1 |
| `Unhealthy` | No connections after 60s uptime, OR error rate > 50% | 2 |

The health check is available via:
- **CLI**: `aafp health --identity /data/keys/agent.key` (exits with 0/1/2)
- **SDK**: `agent.health_check()` returns `HealthStatus`
- **RPC**: `aafp.metrics` RPC method returns `MetricsRpcResponse` with health + metrics

### Warmup period

During the first 60 seconds after startup (`uptime_seconds < 60`), the agent is
considered `Healthy` even with zero connections. This prevents false-negative
health checks during pod initialization. The `startupProbe` uses a longer
failure threshold (12 retries × 5s = 60s) to accommodate this.

### Kubernetes probe configuration

```yaml
livenessProbe:
  exec:
    command: ["/aafp-agent", "health"]
  initialDelaySeconds: 10
  periodSeconds: 30
  timeoutSeconds: 5
  failureThreshold: 3
  # Unhealthy after: 10s + (3 × 30s) = 100s of continuous failure

readinessProbe:
  exec:
    command: ["/aafp-agent", "health"]
  initialDelaySeconds: 5
  periodSeconds: 10
  timeoutSeconds: 3
  failureThreshold: 2
  # Not ready after: 5s + (2 × 10s) = 25s of failure
  # Ready again after: 1 successful check (10s)

startupProbe:
  exec:
    command: ["/aafp-agent", "health"]
  periodSeconds: 5
  failureThreshold: 12
  # Startup timeout: 12 × 5s = 60s (matches warmup period)
```

### Why exec probes (not HTTP)?

The Prometheus exporter (`PrometheusExporter` in `aafp-sdk/src/prometheus.rs`)
serves only `GET /metrics` and returns 404 for all other paths. It does not
have a dedicated `/health` endpoint. Using exec probes (`/aafp-agent health`)
is the correct approach for distroless containers — it calls the binary
directly without requiring a shell.

**Future improvement:** Add a `/health` endpoint to the Prometheus exporter
so HTTP-based probes can be used. This would reduce probe overhead (no process
fork) and allow the metrics port to serve dual purpose.

### Health check via RPC (for sidecar/ambassador patterns)

If running a sidecar that needs to check agent health programmatically:

```rust
// Sidecar queries agent via AAFP RPC
let response = agent.call_rpc("aafp.metrics", &[]).await?;
let metrics_response = MetricsRpcResponse::from_cbor(&response)?;
match metrics_response.health {
    HealthStatus::Healthy => /* 200 OK */,
    HealthStatus::Degraded => /* 200 OK with warning */,
    HealthStatus::Unhealthy => /* 503 Service Unavailable */,
}
```

---

## 8. Graceful Shutdown and Connection Draining

### Shutdown sequence

When a pod receives SIGTERM (from `kubectl delete` or rolling update):

```
1. SIGTERM received
   ↓
2. Kubernetes sets pod to Terminating, removes from Service endpoints
   ↓
3. Agent stops accepting new connections (QUIC endpoint stops listening)
   ↓
4. Agent sends CLOSE frames on all active streams (RFC-0002 §6.6)
   ↓
5. CloseManager transitions: Open → LocalCloseSent → CloseReceived → Closed
   ↓
6. Connection pool evicts all connections (idle timeout bypassed)
   ↓
7. DHT records published for removal (best-effort, non-blocking)
   ↓
8. Process exits with code 0
```

### CloseManager state machine

The `CloseManager` (`aafp-messaging/src/close_manager.rs`) is the single
authority for all CLOSE frame state transitions. It is transport-agnostic
and synchronous. The five states ensure orderly shutdown:

```
Open ──(send CLOSE)──▶ LocalCloseSent
                           │
              (recv CLOSE) │
                           ▼
                   CloseReceived ──(recv CLOSE)──▶ Closed
                           │
              (send CLOSE) │
                           ▼
                   RemoteCloseReceived
                           │
              (send CLOSE) │
                           ▼
                       Closed
```

### terminationGracePeriodSeconds

Set to **60 seconds** (default) or **90 seconds** for production. This gives
the agent time to:

1. Send CLOSE frames on all active streams (typically < 1s per stream)
2. Wait for peer acknowledgment (up to `max_idle_timeout` = 30s)
3. Clean up DHT state (best-effort, non-blocking)

```yaml
spec:
  terminationGracePeriodSeconds: 60  # or 90 for production
```

### Connection draining details

The QUIC transport (`aafp-transport-quic/src/transport.rs`) and connection
pool (`aafp-sdk/src/connection_pool.rs`) handle draining:

- **Connection pool**: Idle connections are evicted after `DEFAULT_IDLE_TIMEOUT`
  (60s). On shutdown, all connections are force-closed immediately.
- **QUIC endpoint**: `Endpoint::close()` sends a CONNECTION_CLOSE frame to all
  peers, which they process as a transport-level close.
- **Keep-alive**: The `KeepAliveConfig` (PING/PONG, default 30s interval) is
  disabled during shutdown to avoid sending probes to peers we're abandoning.

### PreStop hook (optional)

For environments where SIGTERM delivery is delayed (e.g., when the container
runtime queues signals), add a `preStop` hook to begin draining immediately:

```yaml
lifecycle:
  preStop:
    exec:
      command: ["/aafp-agent", "drain"]
      # The "drain" subcommand stops accepting new connections and
      # sends CLOSE frames on all active streams.
      # Note: This subcommand is a proposed addition. Currently,
      # SIGTERM triggers the same behavior via the Tokio signal handler.
```

### What NOT to do

- **Do not use `kill -9`** (SIGKILL). This bypasses the CloseManager and leaves
  peers with half-open connections that only time out after `max_idle_timeout`.
- **Do not set `terminationGracePeriodSeconds` < 30**. QUIC idle timeout is 30s;
  shorter grace periods force-kill the process before peers are notified.
- **Do not rely on TCP RST**. QUIC uses UDP; there is no TCP RST. Connection
  closure is explicit via QUIC CONNECTION_CLOSE frames.

---

## 9. Blue/Green Deployment for Agent Upgrades

### Strategy

AAFP agents are stateful (they hold QUIC connections and DHT routing state).
Blue/green deployment minimizes disruption by running the new version
alongside the old version, shifting traffic gradually, then decommissioning
the old version.

```
┌─────────────────────────────────────────────────────────────────┐
│  Blue (current version)          Green (new version)            │
│  ┌─────┐ ┌─────┐ ┌─────┐        ┌─────┐ ┌─────┐ ┌─────┐        │
│  │ Pod │ │ Pod │ │ Pod │        │ Pod │ │ Pod │ │ Pod │        │
│  │  1  │ │  2  │ │  3  │        │  1  │ │  2  │ │  3  │        │
│  └──┬──┘ └──┬──┘ └──┬──┘        └──┬──┘ └──┬──┘ └──┬──┘        │
│     └───────┴───────┘               │       │       │           │
│     Service: aafp-agent-blue        └───────┴───────┘           │
│                                      Service: aafp-agent-green   │
└─────────────────────────────────────────────────────────────────┘
```

### Implementation with two Helm releases

```bash
# 1. Deploy green (new version) alongside blue (current)
helm install aafp-agent-green ./aafp-agent \
  -f values-production.yaml \
  --set image.tag=0.2.0 \
  --set service.headless=true \
  -n aafp

# 2. Wait for green to be healthy
kubectl wait --for=condition=ready pod -l app=aafp-agent-green \
  -n aafp --timeout=120s

# 3. Verify green agents have joined the DHT
kubectl exec -it deploy/aafp-agent-green -- /aafp-agent peers

# 4. Shift discovery to green (update relay bootstrap, DNS, or ConfigMap)
#    New agents will discover green pods; existing connections to blue
#    remain active until naturally closed.

# 5. Drain blue connections (send CLOSE frames via rolling restart)
kubectl rollout restart deployment/aafp-agent-blue -n aafp

# 6. Wait for blue pods to terminate gracefully
kubectl wait --for=delete pod -l app=aafp-agent-blue \
  -n aafp --timeout=300s

# 7. Remove blue release
helm uninstall aafp-agent-blue -n aafp

# 8. Rename green to blue (or keep as green for next cycle)
#    Option A: Keep as green, next deployment is blue
#    Option B: helm uninstall + helm install with new name
```

### Canary deployment (alternative)

For smaller changes (bug fixes, config tuning), use canary deployment with
weighted traffic splitting:

```bash
# Install Flagger or Argo Rollouts for canary automation
# With Argo Rollouts:
kubectl argo rollouts promote aafp-agent --timeout 30s
```

```yaml
# argo-rollouts.yaml (alternative to Deployment)
apiVersion: argoproj.io/v1alpha1
kind: Rollout
metadata:
  name: aafp-agent
spec:
  replicas: 5
  strategy:
    canary:
      canaryService: aafp-agent-canary
      stableService: aafp-agent-stable
      trafficRouting:
        smi:
          rootService: aafp-agent
      steps:
        - setWeight: 20
        - pause: { duration: 5m }
        - setWeight: 40
        - pause: { duration: 5m }
        - setWeight: 60
        - pause: { duration: 5m }
        - setWeight: 80
        - pause: { duration: 5m }
  selector:
    matchLabels:
      app: aafp-agent
  template:
    # ... same as Deployment template
```

### Version compatibility

AAFP uses version negotiation (RFC-0006) during the handshake. Agents
running different versions can coexist as long as they share a common
protocol version. The `AAFP_ALPN` constant (`b"aafp/1"`) ensures both
client and server negotiate the same major version.

**Before upgrading:**
1. Check the RFC changelog for breaking changes
2. Verify the new version supports the same ALPN (`aafp/1`)
3. Run conformance tests: `cargo test -p aafp-conformance`
4. Deploy to staging first, verify DHT interop with production relays

---

## 10. Resource Limits and Tuning

### CPU

| Component | CPU cost | Notes |
|-----------|----------|-------|
| ML-DSA-65 signature verify | ~0.5ms per verify | Dominates handshake CPU. Rate-limited to 10/sec/IP. |
| ML-DSA-65 signature sign | ~0.3ms per sign | Only during handshake and key rotation. |
| QUIC packet processing | ~10µs per packet | Dominates steady-state CPU. Scales with message rate. |
| CBOR encode/decode | ~1µs per frame | Negligible for typical message sizes. |
| DHT lookup | ~1ms per hop | α=3 concurrency, k=5 replication. |

**Recommendation:** 250m request, 1000m limit for low-traffic agents.
500m request, 2000m limit for high-traffic agents (> 1000 msg/s).

### Memory

| Component | Memory | Notes |
|-----------|--------|-------|
| Base process | ~20MB | Tokio runtime + static data. |
| Per-connection | ~50KB | QUIC connection state + session. |
| Connection pool (100 conns) | ~5MB | `DEFAULT_MAX_POOL_SIZE = 100`. |
| DHT routing table (500 nodes) | ~2MB | 256 k-buckets, k=5 per bucket. |
| TLS session cache | ~200KB | Optional, for session resumption. |
| Tokio thread stack | 2MB × N | `thread_stack_size: 2MB` (down from 8MB default). |

**Recommendation:** 128Mi request, 512Mi limit for standard agents.
256Mi request, 1Gi limit for relay nodes (more connections, larger DHT).

### File descriptors (QUIC streams)

Each QUIC connection can have up to `max_concurrent_streams` (default: 100)
bidirectional streams. Each stream consumes file-descriptor-like resources
in quinn's internal state. With 100 connections × 100 streams = 10,000
concurrent streams, the process needs a high `ulimit -n`.

```yaml
# In the pod spec, set FD limits via security context
# (Kubernetes does not directly support ulimit, use a process manager
# or set it in the container image's /etc/security/limits.conf)

# For distroless (no shell), set via the process:
# The Tokio runtime handles this internally; quinn uses epoll which
# scales with the system FD limit.

# Systemd (for bare metal / VM deployments):
# LimitNOFILE=65536  (already set in deploy/systemd/aafp-agent.service)

# Docker:
# docker run --ulimit nofile=65536:65536 ...
```

### Tokio runtime tuning

The `RuntimeConfig` (`aafp-sdk/src/runtime_config.rs`) provides two presets:

| Preset | Flavor | Workers | Stack | Use case |
|--------|--------|---------|-------|----------|
| `high_throughput()` | MultiThread | auto (physical cores) | 2MB | Production servers |
| `low_latency()` | CurrentThread | 1 | 2MB | Localhost RPC, low-latency |

For production, use `high_throughput()` (the default). The multi-thread
runtime with work-stealing handles concurrent connections efficiently.

For latency-critical agents (e.g., inference with < 1ms p99), use
`low_latency()` and pin to a specific core:

```rust
use aafp_sdk::{AgentBuilder, RuntimeConfig, RuntimeFlavor};

let agent = AgentBuilder::new()
    .with_runtime_config(RuntimeConfig {
        flavor: RuntimeFlavor::CurrentThread,
        worker_threads: 1,
        thread_stack_size: 2 * 1024 * 1024,
        max_blocking_threads: 128,
    })
    .build()
    .await?;
```

### QUIC transport tuning

The `QuicConfig` defaults (`aafp-transport-quic/src/config.rs`) are tuned
for localhost/LAN. For WAN production:

```rust
let quic_config = QuicConfig {
    bind_addr: "0.0.0.0:4433".parse()?,
    max_concurrent_streams: 100,          // default
    keep_alive_interval: Duration::from_secs(30),  // default
    enable_pq: true,                       // PQ KEX (X25519MLKEM768)
    congestion: CongestionController::Cubic,  // default; BBR for WAN
    initial_rtt: Duration::from_millis(50),    // 50ms for WAN (10ms for LAN)
    max_idle_timeout: Duration::from_secs(60), // 60s for WAN (30s default)
    max_ack_delay: Duration::from_millis(10),  // 10ms for WAN (5ms default)
    stream_initial_max_data: 1024 * 1024,      // 1MB (default)
    crypto_buffer_size: 8192,                   // default
};
```

### Connection pool tuning

```rust
use aafp_sdk::connection_pool::PoolConfig;

let pool_config = PoolConfig {
    max_size: 100,                                    // DEFAULT_MAX_POOL_SIZE
    idle_timeout: Duration::from_secs(60),            // DEFAULT_IDLE_TIMEOUT
    health_check_threshold: Duration::from_secs(5),   // HEALTH_CHECK_THRESHOLD
};
```

| Parameter | Default | Production | Rationale |
|-----------|---------|------------|-----------|
| `max_size` | 100 | 200 | More peers in production mesh. |
| `idle_timeout` | 60s | 120s | WAN connections are expensive; keep longer. |
| `health_check_threshold` | 5s | 10s | WAN RTT is higher; allow more time. |

---

## 11. Monitoring Stack Integration

### Prometheus metrics

The `PrometheusExporter` (`aafp-sdk/src/prometheus.rs`) serves metrics in
Prometheus text format on `GET /metrics`. All metrics are labeled with
`agent_id` (the hex-encoded ML-DSA-65 public key hash).

**Exposed metrics:**

| Metric | Type | Description |
|--------|------|-------------|
| `aafp_connections_active` | gauge | Current active connections |
| `aafp_connections_total` | counter | Total connections established |
| `aafp_messages_sent_total` | counter | Total messages sent |
| `aafp_messages_received_total` | counter | Total messages received |
| `aafp_bytes_sent_total` | counter | Total bytes sent |
| `aafp_bytes_received_total` | counter | Total bytes received |
| `aafp_handshakes_completed_total` | counter | Total handshakes completed |
| `aafp_handshakes_failed_total` | counter | Total handshakes failed |
| `aafp_dht_records` | gauge | DHT records stored |
| `aafp_relay_connections` | gauge | Active relay connections |
| `aafp_messages_failed_total` | counter | Total messages that failed |
| `aafp_uptime_seconds` | gauge | Agent uptime in seconds |

### Prometheus scrape configuration

The existing `deploy/prometheus/prometheus.yml` uses static targets. For
Kubernetes production, use ServiceMonitor (Prometheus Operator) or
annotations-based discovery:

```yaml
# ServiceMonitor (Prometheus Operator)
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: aafp-agent
  namespace: monitoring
  labels:
    app: aafp-agent
spec:
  selector:
    matchLabels:
      app: aafp-agent
  endpoints:
    - port: metrics
      path: /metrics
      interval: 5s
      scrapeTimeout: 3s
      relabelings:
        - sourceLabels: [__meta_kubernetes_pod_ip]
          targetLabel: pod_ip
```

### Prometheus alert rules

```yaml
# alerts.yaml
groups:
  - name: aafp-agent
    rules:
      - alert: AafpAgentUnhealthy
        expr: aafp_connections_active == 0 and aafp_uptime_seconds > 60
        for: 2m
        labels:
          severity: critical
        annotations:
          summary: "AAFP agent {{ $labels.agent_id }} has no connections"
          description: "Agent has been running for > 60s with 0 active connections."

      - alert: AafpAgentHighErrorRate
        expr: |
          rate(aafp_messages_failed_total[5m])
          / (rate(aafp_messages_sent_total[5m]) + rate(aafp_messages_received_total[5m]))
          > 0.1
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "AAFP agent {{ $labels.agent_id }} error rate > 10%"
          description: "Message error rate has exceeded 10% for 5 minutes."

      - alert: AafpAgentHighHandshakeFailure
        expr: |
          rate(aafp_handshakes_failed_total[5m])
          / (rate(aafp_handshakes_completed_total[5m]) + rate(aafp_handshakes_failed_total[5m]))
          > 0.3
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "AAFP agent {{ $labels.agent_id }} handshake failure rate > 30%"
          description: "Handshake failures may indicate key misconfiguration or network issues."

      - alert: AafpAgentDown
        expr: up{job="aafp-agent"} == 0
        for: 1m
        labels:
          severity: critical
        annotations:
          summary: "AAFP agent {{ $labels.instance }} is down"
          description: "Prometheus cannot scrape metrics from this agent."

      - alert: AafpAgentHighMemory
        expr: container_memory_working_set_bytes{container="aafp-agent"} / 1024 / 1024 > 400
        for: 10m
        labels:
          severity: warning
        annotations:
          summary: "AAFP agent {{ $labels.pod }} using > 400MB memory"
          description: "Memory usage approaching 512Mi limit."

      - alert: AafpAgentRestarts
        expr: increase(kube_pod_container_status_restarts_total{container="aafp-agent"}[1h]) > 3
        for: 0m
        labels:
          severity: warning
        annotations:
          summary: "AAFP agent {{ $labels.pod }} restarted > 3 times in 1h"
          description: "Frequent restarts may indicate crashes or OOM kills."
```

### Grafana dashboard

The existing dashboard (`deploy/grafana/aafp-dashboard.json`) provides
visualization. Key panels:

1. **Connection overview**: Active connections (gauge), total connections (counter)
2. **Message throughput**: Sent/received rate (msg/s), bytes/s
3. **Handshake health**: Success rate, failure rate, absolute counts
4. **Error tracking**: Message failures, error rate percentage
5. **DHT state**: Records stored, relay connections
6. **Uptime**: Per-agent uptime with color-coded health status

### Recording rules (for long-term storage)

```yaml
groups:
  - name: aafp-recording
    rules:
      - record: aafp:agent:msg_rate:5m
        expr: rate(aafp_messages_sent_total[5m]) + rate(aafp_messages_received_total[5m])

      - record: aafp:agent:error_rate:5m
        expr: |
          rate(aafp_messages_failed_total[5m])
          / (rate(aafp_messages_sent_total[5m]) + rate(aafp_messages_received_total[5m]))

      - record: aafp:agent:handshake_success_rate:5m
        expr: |
          rate(aafp_handshakes_completed_total[5m])
          / (rate(aafp_handshakes_completed_total[5m]) + rate(aafp_handshakes_failed_total[5m]))
```

---

## 12. Log Aggregation and Tracing

### Structured logging

The AAFP CLI and SDK use `tracing` + `tracing-subscriber` for structured
logging. The CLI initializes with `tracing_subscriber::fmt::init()` which
outputs JSON-formatted logs to stderr when `RUST_LOG` is set.

```bash
# Log level configuration
RUST_LOG=info                    # all modules at info
RUST_LOG=info,aafp_sdk=debug     # SDK at debug, rest at info
RUST_LOG=warn,aafp_transport_quic=trace  # QUIC transport at trace

# JSON output (for log aggregation)
RUST_LOG_FORMAT=json RUST_LOG=info
```

### Log levels

| Level | When to use | Example |
|-------|-------------|---------|
| `error` | Failures that affect user-visible behavior | Handshake failure, connection dropped |
| `warn` | Unexpected but recoverable conditions | Rate limit hit, stale connection evicted |
| `info` | Normal operational events | Agent started, connection established, DHT join |
| `debug` | Diagnostic detail | Frame received, stream opened, keep-alive PING sent |
| `trace` | Per-packet detail | QUIC packet parsed, CBOR field decoded |

### Kubernetes log configuration

```yaml
# In the pod spec, set log level via environment variable
env:
  - name: RUST_LOG
    value: "info,aafp_sdk=warn,aafp_transport_quic=warn"
  - name: RUST_LOG_FORMAT
    value: "json"  # structured JSON for log aggregation
```

### Fluent Bit / Fluentd pipeline

```yaml
# fluent-bit-configmap.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: fluent-bit-config
data:
  fluent-bit.conf: |
    [INPUT]
        Name              tail
        Path              /var/log/containers/aafp-agent*.log
        Parser            docker
        Tag               aafp.*
        Refresh_Interval  5

    [FILTER]
        Name  lua
        Match aafp.*
        script fluent-bit.lua
        call  apply_aafp_labels

    [OUTPUT]
        Name  elasticsearch
        Match aafp.*
        Host  elasticsearch.logging
        Index aafp-logs
        Type  _doc
```

### Tracing spans

The SDK uses `tracing` spans for distributed tracing. Key spans:

| Span | Location | Duration |
|------|----------|----------|
| `handshake` | `aafp-sdk/src/handshake_driver.rs` | 10-300ms (ML-DSA-65 verify) |
| `quic_connect` | `aafp-transport-quic/src/transport.rs` | 1-100ms (TLS + QUIC handshake) |
| `quic_accept` | `aafp-transport-quic/src/transport.rs` | 1-100ms |
| `dht_lookup` | `aafp-discovery/src/dht_router.rs` | 1-50ms per hop |
| `frame_encode` | `aafp-messaging/src/framing.rs` | < 1ms |
| `frame_decode` | `aafp-messaging/src/framing.rs` | < 1ms |
| `rpc_dispatch` | `aafp-sdk/src/simple.rs` | varies by handler |

### OpenTelemetry integration (proposed)

For production distributed tracing, export spans to OpenTelemetry-compatible
backends (Jaeger, Tempo, Datadog):

```rust
// Proposed: add to AgentBuilder
use opentelemetry_otlp::WithExportConfig;

let tracer = opentelemetry_otlp::new_pipeline()
    .tracing()
    .with_exporter(
        opentelemetry_otlp::new_exporter()
            .tonic()
            .with_endpoint("http://otel-collector:4317"),
    )
    .install_batch(opentelemetry::runtime::Tokio)?;

let opentelemetry_layer = tracing_opentelemetry::layer().with_tracer(tracer);

tracing_subscriber::registry()
    .with(opentelemetry_layer)
    .with(tracing_subscriber::fmt::layer())
    .init();
```

### Log correlation

Each QUIC connection has a unique connection ID. Include this in log
entries to correlate logs across agents for a single request flow:

```
# Agent A log
{"ts":"2026-07-04T12:00:00Z","level":"info","target":"aafp_sdk::server",
 "msg":"connection established","peer_id":"abc123","conn_id":"conn-xyz789"}

# Agent B log (same connection, different agent)
{"ts":"2026-07-04T12:00:00Z","level":"info","target":"aafp_sdk::client",
 "msg":"connected to peer","peer_id":"def456","conn_id":"conn-xyz789"}
```

---

## 13. Network and NAT Considerations

### UDP in Kubernetes

Kubernetes networking is primarily TCP-oriented. UDP works but has caveats:

1. **kube-proxy UDP load balancing**: Uses conntrack to map flows. QUIC
   connection IDs help, but pod restarts break existing flows. Use headless
   Services for agent-to-agent traffic.

2. **Network policies**: Must explicitly allow UDP on port 4433:

```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: aafp-agent-netpol
spec:
  podSelector:
    matchLabels:
      app: aafp-agent
  policyTypes:
    - Ingress
    - Egress
  ingress:
    # Allow QUIC from other AAFP agents
    - from:
        - podSelector:
            matchLabels:
              app: aafp-agent
      ports:
        - protocol: UDP
          port: 4433
    # Allow Prometheus scrapes
    - from:
        - namespaceSelector:
            matchLabels:
              name: monitoring
      ports:
        - protocol: TCP
          port: 9090
  egress:
    # Allow DNS
    - to: []
      ports:
        - protocol: UDP
          port: 53
    # Allow QUIC to other agents and relays
    - to: []
      ports:
        - protocol: UDP
          port: 4433
    # Allow HTTPS for external API calls (if agent needs them)
    - to: []
      ports:
        - protocol: TCP
          port: 443
```

### NAT traversal

AAFP implements NAT traversal via three mechanisms (Track N5):

1. **AutoNAT dial-back** (`aafp-nat/src/auto_nat_v1.rs`): Agent asks peers to
   dial back to determine if it's behind NAT.
2. **Relay forwarding** (`aafp-nat/src/relay.rs`): Relayed connections through
   a public relay node.
3. **DCuTR hole punching** (`aafp-nat/src/dcutr_v1.rs`): Upgrades relayed
   connections to direct connections via simultaneous open.

**Production relay deployment:**

Relays need public IPs and stable endpoints. Deploy as a separate
Deployment with a LoadBalancer Service:

```yaml
---
apiVersion: v1
kind: Service
metadata:
  name: aafp-relay
  labels:
    app: aafp-relay
spec:
  type: LoadBalancer
  selector:
    app: aafp-relay
  ports:
    - port: 4433
      targetPort: 4433
      protocol: UDP
      name: quic
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: aafp-relay
  labels:
    app: aafp-relay
spec:
  replicas: 2  # at least 2 for redundancy
  selector:
    matchLabels:
      app: aafp-relay
  template:
    metadata:
      labels:
        app: aafp-relay
    spec:
      containers:
        - name: aafp-relay
          image: registry.example.com/aafp-agent:v0.1.0
          command: ["/aafp-agent", "relay", "--bind", "0.0.0.0:4433"]
          ports:
            - containerPort: 4433
              protocol: UDP
              name: quic
            - containerPort: 9090
              protocol: TCP
              name: metrics
          env:
            - name: AAFP_METRICS
              value: "0.0.0.0:9090"
            - name: RUST_LOG
              value: "info"
          resources:
            requests:
              cpu: 500m
              memory: 256Mi
            limits:
              cpu: 2000m
              memory: 1Gi
```

### Cross-cluster connectivity

For agents in different Kubernetes clusters, use the public relay as a
bridge. Agents in cluster A discover the relay via DNS
(`quic://relay.example.com:4433`), and agents in cluster B do the same.
The relay forwards traffic between them.

```
Cluster A (private)          Public Relay           Cluster B (private)
┌──────────────┐          ┌──────────────┐          ┌──────────────┐
│ Agent A1     │─────────▶│              │◀─────────│  Agent B1    │
│ Agent A2     │  relayed │  Relay Node  │  relayed │  Agent B2    │
│ Agent A3     │─────────▶│  (public IP) │◀─────────│  Agent B3    │
└──────────────┘          └──────────────┘          └──────────────┘
```

---

## 14. Production Checklist

### Container Image

- [ ] 1. Dockerfile uses multi-stage build (builder + distroless runtime)
- [ ] 2. Runtime image is distroless (no shell, no package manager)
- [ ] 3. Container runs as non-root (UID 65532)
- [ ] 4. Binary is stripped (`strip target/release/aafp-agent`)
- [ ] 5. LTO enabled in build (`RUSTFLAGS="-C lto=fat"`)
- [ ] 6. Image is < 30MB
- [ ] 7. Image is tagged with semantic version (not `:latest` in production)
- [ ] 8. Image is signed (cosign / notation) for supply chain security
- [ ] 9. Image is scanned for vulnerabilities (Trivy / Grype) in CI
- [ ] 10. EXPOSE includes both UDP 4433 and TCP 9090

### Kubernetes Manifests

- [ ] 11. `readOnlyRootFilesystem: true` in container security context
- [ ] 12. `allowPrivilegeEscalation: false` in container security context
- [ ] 13. All Linux capabilities dropped (`capabilities.drop: [ALL]`)
- [ ] 14. `runAsNonRoot: true` in both pod and container security contexts
- [ ] 15. Resource requests AND limits are set (CPU and memory)
- [ ] 16. `terminationGracePeriodSeconds` >= 60
- [ ] 17. PodDisruptionBudget ensures `minAvailable` >= 2
- [ ] 18. Service exposes UDP port for QUIC (`protocol: UDP`)
- [ ] 19. Service exposes TCP port for Prometheus metrics
- [ ] 20. ConfigMap is used for non-sensitive configuration
- [ ] 21. Secret is used for keypair (not ConfigMap)
- [ ] 22. Secret is mounted read-only (`readOnly: true`)
- [ ] 23. Secret file permissions are 0400 (`defaultMode: 0400`)
- [ ] 24. DHT state uses emptyDir (not persistent volume)
- [ ] 25. Rolling update strategy with `maxUnavailable: 0`

### Probes

- [ ] 26. Liveness probe configured (exec-based, 30s period)
- [ ] 27. Readiness probe configured (exec-based, 10s period)
- [ ] 28. Startup probe configured (60s failure window)
- [ ] 29. Probe uses direct binary call (no shell — distroless)
- [ ] 30. `initialDelaySeconds` accounts for QUIC endpoint startup

### Identity and Secrets

- [ ] 31. ML-DSA-65 keypair generated offline (not in container)
- [ ] 32. Keypair stored in Kubernetes Secret (or ExternalSecret)
- [ ] 33. Service account has minimal RBAC (read only its own secret)
- [ ] 34. `automountServiceAccountToken: false`
- [ ] 35. Key rotation policy documented (90-day interval)
- [ ] 36. Key rotation procedure tested in staging
- [ ] 37. Revocation list (CRL) distribution mechanism defined
- [ ] 38. Emergency key compromise response plan documented

### TLS and Crypto

- [ ] 39. Post-quantum KEX enabled (`enable_pq: true` in QuicConfig)
- [ ] 40. ALPN negotiation set to `aafp/1`
- [ ] 41. Self-signed TLS certificates are acceptable (identity is at app layer)
- [ ] 42. `max_idle_timeout` tuned for WAN (60s, not 30s default)
- [ ] 43. `initial_rtt` tuned for deployment network (10ms LAN, 50ms WAN)
- [ ] 44. Congestion controller appropriate (Cubic for mixed, BBR for WAN)

### Networking

- [ ] 45. UDP port 4433 allowed in NetworkPolicy (ingress and egress)
- [ ] 46. TCP port 9090 allowed from monitoring namespace
- [ ] 47. Headless Service used for agent-to-agent QUIC (bypass UDP LB)
- [ ] 48. Relay deployed with LoadBalancer Service (public IP)
- [ ] 49. At least 2 relay replicas for redundancy
- [ ] 50. DNS records configured for relay endpoints
- [ ] 51. Firewall rules allow UDP egress to relay addresses

### Monitoring

- [ ] 52. Prometheus scraping `/metrics` at 5s interval
- [ ] 53. ServiceMonitor or annotations configured
- [ ] 54. Alert rules for `Unhealthy` status (no connections after 60s)
- [ ] 55. Alert rules for high error rate (> 10% for 5m)
- [ ] 56. Alert rules for high handshake failure rate (> 30% for 5m)
- [ ] 57. Alert rules for pod down (scrape failure for 1m)
- [ ] 58. Alert rules for high memory usage (> 80% of limit)
- [ ] 59. Alert rules for pod restarts (> 3 in 1h)
- [ ] 60. Grafana dashboard imported and verified
- [ ] 61. Recording rules for long-term metric storage

### Logging

- [ ] 62. `RUST_LOG` set to appropriate level (info for production)
- [ ] 63. Structured JSON logging enabled for log aggregation
- [ ] 64. Log pipeline (Fluent Bit / Fluentd) configured
- [ ] 65. Log retention policy defined (30 days hot, 90 days cold)
- [ ] 66. Sensitive data (keypair bytes) is NOT logged
- [ ] 67. Connection IDs are logged for cross-agent correlation

### Autoscaling

- [ ] 68. HPA configured with CPU and memory targets
- [ ] 69. `minReplicas` >= 3 for high availability
- [ ] 70. `maxReplicas` set based on cluster capacity
- [ ] 71. Scale-up stabilization window <= 60s
- [ ] 72. Scale-down stabilization window >= 300s (avoid flapping)
- [ ] 73. Cluster autoscaler enabled (if maxReplicas may exceed current capacity)

### Deployment Process

- [ ] 74. CI pipeline builds and pushes image on tag
- [ ] 75. Image is deployed to staging before production
- [ ] 76. Conformance tests pass in CI (`cargo test -p aafp-conformance`)
- [ ] 77. Helm chart is versioned and stored in chart registry
- [ ] 78. `helm upgrade --dry-run` tested before actual upgrade
- [ ] 79. Rollback procedure tested (`helm rollback`)
- [ ] 80. Blue/green or canary strategy documented and tested

### Graceful Shutdown

- [ ] 81. `terminationGracePeriodSeconds` >= 60
- [ ] 82. Agent sends CLOSE frames on all streams during shutdown
- [ ] 83. Connection pool drains on SIGTERM
- [ ] 84. No SIGKILL before grace period expires
- [ ] 85. PreStop hook configured (if signal delivery is delayed)

### Resource Tuning

- [ ] 86. CPU request >= 250m (enough for ML-DSA-65 verify)
- [ ] 87. CPU limit >= 1000m (burst capacity for handshake spikes)
- [ ] 88. Memory request >= 128Mi
- [ ] 89. Memory limit >= 512Mi
- [ ] 90. File descriptor limit >= 65536 (for QUIC streams)
- [ ] 91. Tokio runtime configured for production (multi_thread)
- [ ] 92. Thread stack size is 2MB (not 8MB default)
- [ ] 93. Connection pool size matches expected peer count
- [ ] 94. Keep-alive interval is 30s (default) or tuned for network

### Security

- [ ] 95. No secrets in ConfigMaps or environment variables
- [ ] 96. No secrets in image layers
- [ ] 97. Pod security standards enforced (restricted profile)
- [ ] 98. Network policies restrict ingress and egress
- [ ] 99. Image vulnerability scanning in CI
- [ ] 100. RBAC follows least-privilege principle
- [ ] 101. Audit logging enabled on Kubernetes API server
- [ ] 102. ReplayCache enabled (default: 300s retention, 100K max entries)

### Disaster Recovery

- [ ] 103. Keypair backed up in secrets manager (Vault / AWS SM)
- [ ] 104. Helm values stored in version control (GitOps)
- [ ] 105. Kubernetes cluster has regular etcd backups
- [ ] 106. Relay nodes have geographic redundancy (2+ regions)
- [ ] 107. Agent identity can be restored from backup on new cluster
- [ ] 108. DHT can self-heal after total agent loss (peers re-publish)

### Documentation

- [ ] 109. Runbook for agent startup failure
- [ ] 110. Runbook for key rotation
- [ ] 111. Runbook for relay failure
- [ ] 112. Runbook for DHT partition (split-brain)
- [ ] 113. Architecture diagram is current
- [ ] 114. On-call rotation has access to this document

---

## Appendix A: Quick Reference Commands

```bash
# ── Image ────────────────────────────────────────────────────────────────────
docker build -t aafp-agent:v0.1.0 -f implementations/rust/Dockerfile implementations/rust/
docker push registry.example.com/aafp-agent:v0.1.0

# ── Helm ─────────────────────────────────────────────────────────────────────
helm install aafp-agent ./aafp-agent -f values-production.yaml -n aafp --create-namespace
helm upgrade aafp-agent ./aafp-agent -f values-production.yaml -n aafp
helm rollback aafp-agent 1 -n aafp
helm uninstall aafp-agent -n aafp

# ── Kubectl ──────────────────────────────────────────────────────────────────
kubectl get pods -l app=aafp-agent -n aafp
kubectl logs -l app=aafp-agent -n aafp --tail=50 -f
kubectl exec -it deploy/aafp-agent -- /aafp-agent peers
kubectl exec -it deploy/aafp-agent -- /aafp-agent metrics
kubectl exec -it deploy/aafp-agent -- /aafp-agent health
kubectl rollout restart deployment/aafp-agent -n aafp
kubectl rollout status deployment/aafp-agent -n aafp
kubectl scale deployment/aafp-agent --replicas=10 -n aafp

# ── Key management ───────────────────────────────────────────────────────────
aafp init --output agent.key --capabilities inference,translation
kubectl create secret generic aafp-agent-key --from-file=agent.key=agent.key -n aafp

# ── Debugging ────────────────────────────────────────────────────────────────
kubectl describe pod -l app=aafp-agent -n aafp
kubectl get events -n aafp --sort-by='.lastTimestamp'
kubectl top pods -l app=aafp-agent -n aafp
kubectl port-forward svc/aafp-agent 9090:9090 -n aafp  # access metrics locally
curl http://localhost:9090/metrics

# ── Testing ──────────────────────────────────────────────────────────────────
cargo test --workspace                    # all 1864 tests
cargo test -p aafp-conformance            # RFC conformance
cargo test -p aafp-loadtest               # load tests
cargo +nightly fuzz run frame_decode      # fuzz testing
```

---

## Appendix B: Environment Variables Reference

| Variable | Default | Description |
|----------|---------|-------------|
| `AAFP_BIND` | `0.0.0.0:4433` | QUIC bind address |
| `AAFP_METRICS` | `0.0.0.0:9090` | Prometheus metrics bind address |
| `AAFP_CAPABILITIES` | (none) | Comma-separated capability list |
| `AAFP_RELAY` | (none) | Bootstrap relay address (`quic://host:port`) |
| `AAFP_DATA_DIR` | `/data` | Data directory for keys and DHT state |
| `RUST_LOG` | `warn` | Log level (comma-separated per-module) |
| `RUST_LOG_FORMAT` | `text` | Log format (`text` or `json`) |

---

## Appendix C: Key File Paths in the Codebase

| File | Purpose |
|------|---------|
| `implementations/rust/Dockerfile` | Multi-stage container build |
| `deploy/kubernetes/aafp-agent.yaml` | Baseline K8s manifests |
| `deploy/prometheus/prometheus.yml` | Prometheus scrape config |
| `deploy/grafana/aafp-dashboard.json` | Grafana dashboard |
| `deploy/systemd/aafp-agent.service` | systemd unit file |
| `docker-compose.yml` | 3-agent dev setup with monitoring |
| `crates/aafp-sdk/src/metrics.rs` | `AgentMetrics`, `HealthStatus` |
| `crates/aafp-sdk/src/prometheus.rs` | `PrometheusExporter` |
| `crates/aafp-sdk/src/builder.rs` | `AgentBuilder` fluent API |
| `crates/aafp-sdk/src/runtime_config.rs` | `RuntimeConfig` (Tokio tuning) |
| `crates/aafp-sdk/src/server.rs` | `ServerConfig`, `HandshakeRateLimiter` |
| `crates/aafp-sdk/src/connection_pool.rs` | `ConnectionPool`, `PoolConfig` |
| `crates/aafp-sdk/src/cpu_affinity.rs` | Core pinning (Linux) |
| `crates/aafp-identity/src/keypair.rs` | `AgentKeypair` (ML-DSA-65) |
| `crates/aafp-identity/src/key_rotation.rs` | `KeyRotationRecord` (RFC 0011) |
| `crates/aafp-transport-quic/src/config.rs` | `QuicConfig`, `TlsIdentity` |
| `crates/aafp-transport-quic/src/transport.rs` | `QuicTransport` |
| `crates/aafp-messaging/src/close_manager.rs` | `CloseManager` (graceful close) |
| `crates/aafp-messaging/src/keepalive.rs` | `KeepAliveConfig` (PING/PONG) |
| `crates/aafp-cli/src/main.rs` | CLI entry point |
| `crates/aafp-cli/src/commands/health.rs` | Health check command |
| `crates/aafp-cli/src/commands/serve.rs` | Serve command (with metrics) |
