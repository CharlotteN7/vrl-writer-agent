# Monitoring Stack: Prometheus + Grafana for Arkime & Suricata

Complete metrics pipeline for our 25Gbps capture nodes: kernel drops, Suricata
stats, Arkime sessions, OpenSearch health, disk, NIC — all scraped by Prometheus
and visualized in Grafana.

## Architecture

```
┌────────────────────────────────────────────────────────────────┐
│              Each Capture Node (3 total)                       │
│                                                                │
│   Runs LOCAL exporters only (bound to mgmt interface):         │
│                                                                │
│   ┌──────────────────┐  :9100  Linux host metrics              │
│   │  node_exporter   │         CPU, mem, disk, NIC, IRQ        │
│   └──────────────────┘                                         │
│                                                                │
│   ┌──────────────────┐  :9917  Suricata stats via Unix socket  │
│   │ suricata_exporter│         drops, flows, memcap, app-layer │
│   └──────────────────┘                                         │
│                                                                │
│   ┌──────────────────┐  :7979  Arkime JSON→Prom via /api/stats │
│   │  json_exporter   │         sessions, drops, ES write state │
│   └──────────────────┘                                         │
│                                                                │
│   ┌──────────────────┐  :9113  Nginx stub_status               │
│   │nginx-prometheus-e│         requests, connections, upstream │
│   └──────────────────┘                                         │
└────────────────────────┬───────────────────────────────────────┘
                         │ scrape on mgmt network
                         ▼
┌────────────────────────────────────────────────────────────────┐
│                  Monitoring Host (separate)                    │
│                                                                │
│  ┌────────────┐    ┌─────────────┐    ┌──────────────────┐    │
│  │ Prometheus │◀──▶│ Alertmanager│    │     Grafana      │    │
│  │  (30d TSDB)│    │ (Slack/PD/  │    │   (dashboards)   │    │
│  │            │    │  email)     │    │                  │    │
│  └────────────┘    └─────────────┘    └──────────────────┘    │
└────────────────────────────────────────────────────────────────┘
```

**Rule:** Prometheus TSDB and Grafana go on a **separate monitoring host** — never on capture nodes. Capture hosts are memory/IRQ/disk-pressured; running a TSDB there causes noisy-neighbor packet drops.

---

## 1. Prerequisites on Capture Nodes

### Enable Suricata's Unix command socket

The `suricata_exporter` reads metrics via the socket — not via log files (more accurate, lower overhead).

```yaml
# /etc/suricata/suricata.yaml — add this block near the top
unix-command:
  enabled: yes
  filename: /var/run/suricata/suricata-command.socket
```

```bash
# Make the run dir persistent (tmpfs gets wiped on reboot)
sudo mkdir -p /var/run/suricata
sudo chown suricata:suricata /var/run/suricata

# The capture-tuning service already runs BEFORE suricata;
# add a line to it to create the dir if missing:
# mkdir -p /var/run/suricata; chown suricata:suricata /var/run/suricata

sudo systemctl restart suricata

# Verify socket is created
ls -la /var/run/suricata/suricata-command.socket
# Expected: srw-rw---- 1 suricata suricata ...
```

### Enable nginx stub_status (for nginx-prometheus-exporter)

Add this `location` block to your main nginx vhost (but IP-restricted so only the exporter can reach it):

```nginx
# Add inside the arkime.example.com server block:
location = /stub_status {
    stub_status;
    allow 127.0.0.1;
    deny all;
}
```

---

## 2. node_exporter — OS-level metrics

```bash
# Download latest release (check https://github.com/prometheus/node_exporter/releases)
cd /tmp
NODE_EXP_VER=1.8.2
curl -LO https://github.com/prometheus/node_exporter/releases/download/v${NODE_EXP_VER}/node_exporter-${NODE_EXP_VER}.linux-amd64.tar.gz
tar xzf node_exporter-${NODE_EXP_VER}.linux-amd64.tar.gz
sudo install -m 0755 node_exporter-${NODE_EXP_VER}.linux-amd64/node_exporter /usr/local/bin/

# System user
sudo useradd --system --no-create-home --shell /sbin/nologin node_exp

# Systemd unit
sudo tee /etc/systemd/system/node_exporter.service << 'EOF'
[Unit]
Description=Prometheus Node Exporter
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=node_exp
Group=node_exp
# Bind to mgmt interface only — adjust IP/interface as needed
ExecStart=/usr/local/bin/node_exporter \
    --web.listen-address=127.0.0.1:9100 \
    --collector.filesystem.mount-points-exclude="^/(sys|proc|dev|run|var/lib/docker|boot)($|/)" \
    --collector.netclass.ignored-devices="^(veth|docker|br-|lo)" \
    --collector.textfile.directory=/var/lib/node_exporter/textfile
Restart=on-failure
RestartSec=10
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true

[Install]
WantedBy=multi-user.target
EOF

sudo mkdir -p /var/lib/node_exporter/textfile
sudo chown node_exp:node_exp /var/lib/node_exporter/textfile

sudo systemctl daemon-reload
sudo systemctl enable --now node_exporter

# Verify
curl -s http://127.0.0.1:9100/metrics | head -5
```

Tip: the textfile directory lets you emit custom metrics from shell scripts — useful for RAID health, CacheVault status, etc.

---

## 3. suricata_exporter — Corelight's exporter

```bash
# Download latest release (v0.5.0+ supports Suricata 8.0)
cd /tmp
SURI_EXP_VER=0.5.0
curl -LO https://github.com/corelight/suricata_exporter/releases/download/v${SURI_EXP_VER}/suricata_exporter_${SURI_EXP_VER}_linux_amd64.tar.gz
tar xzf suricata_exporter_${SURI_EXP_VER}_linux_amd64.tar.gz
sudo install -m 0755 suricata_exporter /usr/local/bin/

# System user (must be able to read the Suricata socket)
sudo useradd --system --no-create-home --shell /sbin/nologin suricata_exp
sudo usermod -aG suricata suricata_exp

# Systemd unit
sudo tee /etc/systemd/system/suricata_exporter.service << 'EOF'
[Unit]
Description=Prometheus exporter for Suricata
After=suricata.service
Wants=suricata.service

[Service]
Type=simple
User=suricata_exp
Group=suricata
ExecStart=/usr/local/bin/suricata_exporter \
    -suricata.socket-path=/var/run/suricata/suricata-command.socket \
    -web.listen-address=127.0.0.1:9917 \
    -totals
Restart=on-failure
RestartSec=10
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable --now suricata_exporter

# Verify
curl -s http://127.0.0.1:9917/metrics | head -20
# Expected: suricata_uptime_seconds, suricata_capture_kernel_packets_total,
#           suricata_capture_kernel_drops_total, suricata_flow_*
```

**Flag notes:**
- `-totals` collapses per-thread metrics to global. Drop this flag for per-thread visibility (high cardinality — 44 series multiplier per metric — only use if you actively debug per-thread issues)
- Without `-totals`, cardinality explodes: `44 threads × 20 metrics = 880 series` per node

---

## 4. Arkime: json_exporter bridge to `/api/stats`

Arkime has no native Prometheus endpoint. We use `prometheus-community/json_exporter` to scrape Arkime's JSON API and expose it as Prometheus metrics.

```bash
# Download json_exporter
cd /tmp
JSON_EXP_VER=0.6.0
curl -LO https://github.com/prometheus-community/json_exporter/releases/download/v${JSON_EXP_VER}/json_exporter-${JSON_EXP_VER}.linux-amd64.tar.gz
tar xzf json_exporter-${JSON_EXP_VER}.linux-amd64.tar.gz
sudo install -m 0755 json_exporter-${JSON_EXP_VER}.linux-amd64/json_exporter /usr/local/bin/
sudo useradd --system --no-create-home --shell /sbin/nologin json_exp

# Config — tells json_exporter which JSON fields to expose
sudo mkdir -p /etc/json_exporter
sudo tee /etc/json_exporter/arkime.yml << 'EOF'
modules:
  arkime_stats:
    metrics:
      - name: arkime_total_packets
        type: object
        path: '{.data[*]}'
        labels:
          node: '{.nodeName}'
        values:
          packets_total:       '{.totalPackets}'
          packets_dropped:     '{.totalDropped}'
          packets_overload:    '{.totalOverloadDropped}'
          sessions_total:      '{.totalSessions}'
          es_dropped:          '{.totalES}'
          es_health_ms:        '{.esHealthMS}'
          deltaPacketsPerSec:  '{.deltaPacketsPerSec}'
          deltaDroppedPerSec:  '{.deltaDroppedPerSec}'
          deltaOverloadPerSec: '{.deltaOverloadDroppedPerSec}'
          deltaSessionsPerSec: '{.deltaSessionsPerSec}'
          deltaESDroppedPerSec:'{.deltaESDroppedPerSec}'
          memory:              '{.memory}'
          cpu:                 '{.cpu}'
          disk_queue:          '{.diskQueue}'
          suricataAlerts:      '{.suricataAlerts}'
          suricataMatches:     '{.suricataMatches}'

  arkime_eshealth:
    metrics:
      - name: arkime_es_health
        type: object
        path: '{ . }'
        values:
          status:           '{.status}'      # "green"/"yellow"/"red" — needs mapping
          active_shards:    '{.active_shards}'
          unassigned_shards:'{.unassigned_shards}'
          number_of_nodes:  '{.number_of_nodes}'
          number_of_data_nodes:'{.number_of_data_nodes}'
EOF

sudo chown -R json_exp:json_exp /etc/json_exporter

# Systemd unit
sudo tee /etc/systemd/system/json_exporter.service << 'EOF'
[Unit]
Description=Prometheus JSON Exporter (Arkime bridge)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=json_exp
Group=json_exp
ExecStart=/usr/local/bin/json_exporter \
    --config.file=/etc/json_exporter/arkime.yml \
    --web.listen-address=127.0.0.1:7979
Restart=on-failure
RestartSec=10

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable --now json_exporter

# Verify (replace with your actual arkime digest credentials)
curl -s "http://127.0.0.1:7979/probe?module=arkime_stats&target=https%3A%2F%2Farkime.example.com%2Fapi%2Fstats"
```

### Scraping Arkime with digest auth

Arkime's `/api/*` endpoints require HTTP Digest auth. The exporter relays query strings to the target URL but Prometheus needs to handle auth. Use a **relabel_config** in Prometheus to pass target + auth:

```yaml
# In prometheus.yml (see section 5)
- job_name: arkime_stats
  metrics_path: /probe
  params:
    module: [arkime_stats]
  static_configs:
    - targets:
      - https://arkime.example.com/api/stats
  relabel_configs:
    - source_labels: [__address__]
      target_label: __param_target
    - source_labels: [__param_target]
      target_label: instance
    - target_label: __address__
      replacement: 127.0.0.1:7979    # json_exporter runs locally per capture node
  basic_auth:
    username: arkime_prom_user
    password: SECRET
```

Create a read-only Arkime user for the exporter:

```bash
/opt/arkime/bin/arkime_add_user.sh --insecure arkime_prom_user "Prometheus" SECRET \
    --webauthonly --packetsearch
# Or create via viewer UI with minimal perms — no admin, no createEnabled
```

**Note:** `/api/eshealth` is the one endpoint that does NOT require auth — the simplest metrics to grab.

---

## 5. nginx-prometheus-exporter

```bash
cd /tmp
NGX_EXP_VER=1.4.0
curl -LO https://github.com/nginx/nginx-prometheus-exporter/releases/download/v${NGX_EXP_VER}/nginx-prometheus-exporter_${NGX_EXP_VER}_linux_amd64.tar.gz
tar xzf nginx-prometheus-exporter_${NGX_EXP_VER}_linux_amd64.tar.gz
sudo install -m 0755 nginx-prometheus-exporter /usr/local/bin/
sudo useradd --system --no-create-home --shell /sbin/nologin nginx_exp

sudo tee /etc/systemd/system/nginx-prometheus-exporter.service << 'EOF'
[Unit]
Description=Nginx Prometheus Exporter
After=nginx.service
Wants=nginx.service

[Service]
Type=simple
User=nginx_exp
Group=nginx_exp
ExecStart=/usr/local/bin/nginx-prometheus-exporter \
    --nginx.scrape-uri=http://127.0.0.1/stub_status \
    --web.listen-address=127.0.0.1:9113
Restart=on-failure

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable --now nginx-prometheus-exporter

# Verify
curl -s http://127.0.0.1:9113/metrics | head -20
```

---

## 6. Firewall: expose exporter ports to monitoring host only

```bash
# Replace 10.1.1.10 with your actual Prometheus host IP
MONITORING_IP=10.1.1.10

for PORT in 9100 9917 7979 9113; do
    sudo firewall-cmd --permanent --add-rich-rule="rule family='ipv4' source address='$MONITORING_IP' port port='$PORT' protocol='tcp' accept"
done
sudo firewall-cmd --reload

# Alternatively, bind exporters to the mgmt NIC's address and rely on routing —
# we use 127.0.0.1 above for max safety.
# To actually reach them from the Prometheus host, change --web.listen-address
# to the mgmt interface IP (e.g., 10.0.1.5:9100) on each exporter's systemd unit.
```

---

## 7. Prometheus server setup (on monitoring host)

### Install

```bash
# AlmaLinux 9 install via tarball (or use prometheus-community RPM)
cd /tmp
PROM_VER=2.54.1
curl -LO https://github.com/prometheus/prometheus/releases/download/v${PROM_VER}/prometheus-${PROM_VER}.linux-amd64.tar.gz
tar xzf prometheus-${PROM_VER}.linux-amd64.tar.gz
cd prometheus-${PROM_VER}.linux-amd64

sudo useradd --system --no-create-home --shell /sbin/nologin prometheus
sudo install -m 0755 prometheus promtool /usr/local/bin/
sudo mkdir -p /etc/prometheus /var/lib/prometheus
sudo cp -r consoles console_libraries /etc/prometheus/
sudo chown -R prometheus:prometheus /var/lib/prometheus
```

### Config — `/etc/prometheus/prometheus.yml`

```yaml
global:
  scrape_interval:     15s
  evaluation_interval: 30s
  external_labels:
    cluster: arkime-capture

rule_files:
  - /etc/prometheus/rules/*.yml

alerting:
  alertmanagers:
    - static_configs:
        - targets: ['127.0.0.1:9093']

scrape_configs:
  # Linux host metrics from each capture node
  - job_name: node
    static_configs:
      - targets:
          - capture-node1.mgmt:9100
          - capture-node2.mgmt:9100
          - capture-node3.mgmt:9100

  # Suricata IDS metrics
  - job_name: suricata
    scrape_interval: 15s
    static_configs:
      - targets:
          - capture-node1.mgmt:9917
          - capture-node2.mgmt:9917
          - capture-node3.mgmt:9917

  # Nginx stats
  - job_name: nginx
    static_configs:
      - targets:
          - capture-node1.mgmt:9113
          - capture-node2.mgmt:9113
          - capture-node3.mgmt:9113

  # Arkime viewer stats (via json_exporter bridge on each node)
  - job_name: arkime_stats
    scrape_interval: 30s
    metrics_path: /probe
    params:
      module: [arkime_stats]
    static_configs:
      - targets:
          - https://arkime.example.com/api/stats
    relabel_configs:
      - source_labels: [__address__]
        target_label: __param_target
      - source_labels: [__param_target]
        target_label: instance
      - target_label: __address__
        replacement: capture-node1.mgmt:7979
    basic_auth:
      username: arkime_prom_user
      password_file: /etc/prometheus/arkime_password

  # Arkime OpenSearch cluster health (no auth needed)
  - job_name: arkime_eshealth
    scrape_interval: 30s
    metrics_path: /probe
    params:
      module: [arkime_eshealth]
    static_configs:
      - targets:
          - https://arkime.example.com/api/eshealth
    relabel_configs:
      - source_labels: [__address__]
        target_label: __param_target
      - target_label: __address__
        replacement: capture-node1.mgmt:7979
```

```bash
echo -n 'SECRET' | sudo tee /etc/prometheus/arkime_password
sudo chmod 640 /etc/prometheus/arkime_password
sudo chown prometheus:prometheus /etc/prometheus/arkime_password
```

### Systemd unit

```bash
sudo tee /etc/systemd/system/prometheus.service << 'EOF'
[Unit]
Description=Prometheus
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=prometheus
Group=prometheus
ExecStart=/usr/local/bin/prometheus \
    --config.file=/etc/prometheus/prometheus.yml \
    --storage.tsdb.path=/var/lib/prometheus \
    --storage.tsdb.retention.time=30d \
    --storage.tsdb.retention.size=50GB \
    --web.listen-address=0.0.0.0:9090 \
    --web.enable-lifecycle
Restart=on-failure
LimitNOFILE=65536

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable --now prometheus

# Verify
curl -s http://localhost:9090/-/ready
# Expected: Prometheus Server is Ready.
```

---

## 8. Alert rules

```bash
sudo mkdir -p /etc/prometheus/rules

sudo tee /etc/prometheus/rules/capture-alerts.yml << 'EOF'
groups:
  - name: capture
    interval: 30s
    rules:

      # ---- Suricata packet drops ----
      - alert: SuricataDropsHigh
        expr: |
          rate(suricata_capture_kernel_drops_total[5m])
          /
          clamp_min(rate(suricata_capture_kernel_packets_total[5m]), 1)
          > 0.001
        for: 10m
        labels:
          severity: critical
        annotations:
          summary: "Suricata dropping packets on {{ $labels.instance }}"
          description: "Drop rate: {{ $value | humanizePercentage }} over 10 min"

      # ---- Suricata flow memcap hit ----
      - alert: SuricataFlowMemcapFull
        expr: suricata_flow_memcap_state > 0
        for: 2m
        labels:
          severity: warning
        annotations:
          summary: "Suricata flow memcap hit on {{ $labels.instance }}"
          description: "New flows are being dropped — increase flow.memcap"

      # ---- Arkime packet drops ----
      - alert: ArkimeDroppingPackets
        expr: arkime_total_packets_deltaDroppedPerSec > 0
        for: 5m
        labels:
          severity: critical
        annotations:
          summary: "Arkime capture dropping on {{ $labels.node }}"

      # ---- Arkime ES backpressure ----
      - alert: ArkimeESDropping
        expr: arkime_total_packets_deltaESDroppedPerSec > 0
        for: 5m
        labels:
          severity: critical
        annotations:
          summary: "Arkime dropping sessions because ES can't keep up"

      # ---- OpenSearch cluster health ----
      - alert: OpenSearchUnhealthy
        expr: arkime_es_health_active_shards < 1
        for: 5m
        labels:
          severity: critical
        annotations:
          summary: "OpenSearch cluster reporting issues"

      # ---- Disk full: PCAP volumes ----
      - alert: PcapDiskFull
        expr: |
          node_filesystem_avail_bytes{mountpoint=~"/data/pcap[0-9]+"}
          /
          node_filesystem_size_bytes{mountpoint=~"/data/pcap[0-9]+"}
          < 0.10
        for: 15m
        labels:
          severity: warning
        annotations:
          summary: "PCAP disk {{ $labels.mountpoint }} <10% free on {{ $labels.instance }}"

      # ---- Suricata EVE disk full ----
      - alert: SuricataLogDiskFull
        expr: |
          node_filesystem_avail_bytes{mountpoint="/data/suricata-logs"}
          /
          node_filesystem_size_bytes{mountpoint="/data/suricata-logs"}
          < 0.15
        for: 5m
        labels:
          severity: critical
        annotations:
          summary: "Suricata EVE log disk <15% free — tighten logrotate"

      # ---- Process/exporter down ----
      - alert: ExporterDown
        expr: up == 0
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "Exporter {{ $labels.job }} on {{ $labels.instance }} is down"

      # ---- NIC kernel drops ----
      - alert: NICDrops
        expr: rate(node_network_receive_drop_total{device="eth3"}[5m]) > 0
        for: 10m
        labels:
          severity: warning
        annotations:
          summary: "NIC-level drops on eth3 ({{ $labels.instance }})"

      # ---- Memory pressure ----
      - alert: LowMemory
        expr: node_memory_MemAvailable_bytes / node_memory_MemTotal_bytes < 0.10
        for: 10m
        labels:
          severity: warning
        annotations:
          summary: "Low memory on {{ $labels.instance }}"

      # ---- CacheVault failure (custom metric from textfile collector) ----
      - alert: RaidCacheVaultFailed
        expr: raid_cachevault_healthy == 0
        for: 5m
        labels:
          severity: critical
        annotations:
          summary: "RAID CacheVault failed on {{ $labels.instance }} — WriteBack disabled"
EOF

sudo chown -R prometheus:prometheus /etc/prometheus/rules

# Reload
curl -X POST http://localhost:9090/-/reload
```

---

## 9. Custom metrics via node_exporter textfile collector

For things not covered by existing exporters (RAID CacheVault, Arkime ISM status, etc.), drop prom-format files into `/var/lib/node_exporter/textfile/`:

```bash
sudo tee /usr/local/bin/raid-metrics.sh << 'EOF'
#!/bin/bash
# Writes RAID health metrics to the textfile directory.
# Scheduled via cron/timer every 5 minutes.

OUT=/var/lib/node_exporter/textfile/raid.prom.$$

{
    # CacheVault state: 1 = Optimal, 0 = anything else
    STATE=$(storcli /c0 /cv show 2>/dev/null | awk '/^State/ {print $3}')
    [ "$STATE" = "Optimal" ] && HEALTHY=1 || HEALTHY=0
    echo "# HELP raid_cachevault_healthy 1 if RAID CacheVault is Optimal"
    echo "# TYPE raid_cachevault_healthy gauge"
    echo "raid_cachevault_healthy $HEALTHY"

    # Per-VD state (Optl = 1, anything else = 0)
    storcli /c0 /vall show 2>/dev/null | awk '/^[0-9]+\/[0-9]+/ {
        vd = $1; state = $3
        optl = (state == "Optl") ? 1 : 0
        print "raid_vd_optimal{vd=\"" vd "\"} " optl
    }'
} > "$OUT" && mv "$OUT" /var/lib/node_exporter/textfile/raid.prom
EOF
sudo chmod +x /usr/local/bin/raid-metrics.sh

# Timer every 5 minutes
sudo tee /etc/systemd/system/raid-metrics.service << 'EOF'
[Unit]
Description=RAID health metrics for Prometheus
[Service]
Type=oneshot
ExecStart=/usr/local/bin/raid-metrics.sh
EOF

sudo tee /etc/systemd/system/raid-metrics.timer << 'EOF'
[Unit]
Description=Run raid-metrics every 5 minutes
[Timer]
OnBootSec=5min
OnUnitActiveSec=5min
[Install]
WantedBy=timers.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable --now raid-metrics.timer
```

---

## 10. Grafana setup

```bash
# AlmaLinux 9 install
sudo tee /etc/yum.repos.d/grafana.repo << 'EOF'
[grafana]
name=grafana
baseurl=https://rpm.grafana.com
repo_gpgcheck=1
enabled=1
gpgcheck=1
gpgkey=https://rpm.grafana.com/gpg.key
sslverify=1
sslcacert=/etc/pki/tls/certs/ca-bundle.crt
EOF

sudo dnf install -y grafana
sudo systemctl enable --now grafana-server

# Default: http://localhost:3000, admin/admin (change on first login)
```

### Add Prometheus as data source

In Grafana UI → **Connections → Data sources → Add → Prometheus**:
- URL: `http://localhost:9090`
- Leave everything else default
- **Save & test**

---

## 11. Grafana dashboards

### Import ready-made dashboards

| Dashboard | ID | Use |
|-----------|-----|-----|
| Node Exporter Full | `1860` | OS/host metrics (CPU, mem, disk, net) |
| Nginx Exporter | `12708` | Nginx req rate, connections |
| Alertmanager Overview | `9578` | Alertmanager status |

Import via Grafana UI → **Dashboards → New → Import → paste ID → Load**.

### No ready-made dashboards for Suricata-Prometheus or Arkime exist

Unfortunately there are no maintained community dashboards for `suricata_exporter` metrics or for our `json_exporter`-bridged Arkime metrics as of this writing. Build your own with these key panels:

### Suricata dashboard — core panels to build

```promql
# Packet rate (per node)
rate(suricata_capture_kernel_packets_total[5m])

# Drop rate (CRITICAL — should be near zero)
rate(suricata_capture_kernel_drops_total[5m])

# Drop percentage
rate(suricata_capture_kernel_drops_total[5m])
/
clamp_min(rate(suricata_capture_kernel_packets_total[5m]), 1)
* 100

# Flow memory usage
suricata_flow_memuse
# vs flow.memcap (16 GB in our config)

# Flow memcap breaches (alerts when flow table full)
suricata_flow_memcap_state

# TCP reassembly memory
suricata_tcp_reassembly_memuse
# vs stream.reassembly.memcap (64 GB)

# App-layer protocol rate (what's on your wire)
sum by (app_proto) (rate(suricata_app_layer_flow_total[5m]))

# Alerts per second
rate(suricata_detect_alert_total[5m])
```

### Arkime dashboard — core panels

```promql
# Sessions/sec per instance
arkime_total_packets_deltaSessionsPerSec

# Dropped packets/sec (should be 0)
arkime_total_packets_deltaDroppedPerSec

# Overload drops (queue full)
arkime_total_packets_deltaOverloadPerSec

# ES dropped (OS backpressure)
arkime_total_packets_deltaESDroppedPerSec

# Memory per instance
arkime_total_packets_memory

# CPU per instance
arkime_total_packets_cpu

# Disk queue depth (writes not yet flushed)
arkime_total_packets_disk_queue

# Suricata alert correlation
arkime_total_packets_suricataMatches
/
clamp_min(arkime_total_packets_suricataAlerts, 1)
# Ratio should be near 1.0
```

### Dashboard JSON snippets

Save these as a starting point (import each via **New → Import → Import via JSON**):

For brevity, I'm not embedding full JSON here — build panels iteratively in Grafana, then use **Share → Export** to save them. Commit the resulting JSON to your ops repo.

---

## 12. Deployment checklist

On each capture node:
- [ ] Suricata `unix-command.enabled=yes` + socket exists
- [ ] `node_exporter` running on :9100
- [ ] `suricata_exporter` running on :9917 (with `-totals` unless you need per-thread)
- [ ] `json_exporter` running on :7979
- [ ] `nginx-prometheus-exporter` running on :9113 (if using nginx)
- [ ] `/stub_status` location in nginx restricted to 127.0.0.1
- [ ] Firewall allows monitoring host to reach exporter ports
- [ ] `arkime_prom_user` read-only user created
- [ ] RAID metrics textfile timer running

On monitoring host:
- [ ] Prometheus running on :9090 with 30d retention
- [ ] Alertmanager running on :9093
- [ ] Grafana running on :3000
- [ ] All scrape targets green in Prometheus UI (`http://host:9090/targets`)
- [ ] Alerts loaded (`http://host:9090/alerts`)
- [ ] Data source configured in Grafana
- [ ] Dashboards imported / custom dashboards saved

## 13. Cost / sizing

For 3 capture nodes:
- **Prometheus TSDB**: ~30-50 GB for 30 days (with `-totals` flag on suricata exporter; 3-5x more without)
- **Monitoring host**: 4 vCPU / 8 GB RAM / 200 GB SSD is plenty
- **Scrape load on capture nodes**: negligible (<0.1% CPU)

## 14. Next steps to consider

- **Alertmanager routing**: Slack/PagerDuty/email integrations
- **Long-term storage**: Thanos or VictoriaMetrics for 90d+ retention
- **Auto-discovery**: replace static_configs with file_sd or DNS SD
- **Recording rules**: pre-compute expensive queries (drop percentages, rates)
- **Remote write**: ship metrics to a managed platform if you have one

The stack above is the minimum for production visibility. Suricata drops, Arkime drops, ES health, disk space — if any of these break silently you lose captured traffic. Prometheus catches them within 30 seconds.
