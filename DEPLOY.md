# Deploying PulseAPI to Oracle Cloud (Always Free)

Oracle Cloud's always-free tier gives you a persistent public VM that costs nothing — same setup as the AI Code Review Agent. One afternoon of work gets PulseAPI live with a real URL.

---

## What you'll get

| Service | Public URL |
|---------|-----------|
| Gateway | `http://<your-ip>:3000` |
| Dashboard | `http://<your-ip>:5173` |
| Grafana | `http://<your-ip>:3001` |
| Prometheus | `http://<your-ip>:9090` |

Add a free subdomain via [nip.io](https://nip.io) or [DuckDNS](https://www.duckdns.org) if you want a proper URL without buying a domain.

---

## 1. Provision the VM

1. Sign up at [cloud.oracle.com](https://cloud.oracle.com) (requires credit card for identity; won't be charged).
2. **Create Instance** → Ampere A1 (ARM) — **4 OCPUs + 24 GB RAM** are always free.
3. OS: **Ubuntu 22.04 Minimal**.
4. Download the SSH key pair when prompted.
5. Note the **Public IP** once the instance is running.

---

## 2. Open firewall ports

In Oracle Console → Networking → VCN → Security Lists, add **Ingress Rules**:

| Port | Protocol | Description |
|------|----------|-------------|
| 22   | TCP | SSH |
| 3000 | TCP | PulseAPI Gateway |
| 5173 | TCP | Dashboard |
| 3001 | TCP | Grafana |
| 9090 | TCP | Prometheus |

Also open them in the VM's OS firewall:
```bash
sudo iptables -I INPUT -p tcp --dport 3000 -j ACCEPT
sudo iptables -I INPUT -p tcp --dport 5173 -j ACCEPT
sudo iptables -I INPUT -p tcp --dport 3001 -j ACCEPT
sudo iptables -I INPUT -p tcp --dport 9090 -j ACCEPT
sudo netfilter-persistent save
```

---

## 3. Install Docker on the VM

```bash
ssh -i ~/your-key.pem ubuntu@<your-ip>

# Install Docker
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker ubuntu
newgrp docker

# Install Docker Compose plugin
sudo apt-get install -y docker-compose-plugin
docker compose version   # should print v2.x
```

---

## 4. Deploy PulseAPI

```bash
# Clone your repo (or scp the files)
git clone https://github.com/<you>/pulseapi.git
cd pulseapi

# Set production secrets — never commit this file
cp .env.example .env
nano .env   # set JWT_SECRET, ADMIN_KEY to strong random values

# Build and start — Kafka + all services
docker compose up -d --build

# Tail logs to confirm startup
docker compose logs -f gateway kafka-consumer
```

Wait ~60 seconds for Kafka to elect a controller and for Postgres to init.

```bash
curl http://localhost:3000/health
# → {"status":"ok","db":true,"redis":true,...}
```

---

## 5. Verify the Kafka pipeline

```bash
# Confirm consumer is connected
docker compose logs kafka-consumer | grep "connected"
# → [consumer] connected — topic: request-logs group: pulseapi-log-writer

# Send a test request through the gateway
curl http://localhost:3000/api/ping

# Check the consumer flushed it to Postgres
docker compose exec postgres psql -U pulse -d pulseapi \
  -c "SELECT method, path, status_code, latency_ms FROM requests ORDER BY timestamp DESC LIMIT 5;"
```

---

## 6. Add a free domain (optional but recommended)

[DuckDNS](https://www.duckdns.org) — free subdomain, takes 2 minutes:

1. Log in → create subdomain `pulseapi` → point to your Oracle IP.
2. Update your README demo links to `http://pulseapi.duckdns.org:3000`.

For HTTPS, install Caddy as a reverse proxy:
```bash
sudo apt install -y caddy
sudo nano /etc/caddy/Caddyfile
```
```
pulseapi.duckdns.org {
    reverse_proxy localhost:3000
}
```
```bash
sudo systemctl restart caddy
```
Caddy auto-provisions a Let's Encrypt cert. Gateway is now at `https://pulseapi.duckdns.org`.

---

## 7. Keep it running

```bash
# Auto-restart on VM reboot
docker compose up -d   # --restart: unless-stopped is already set in compose

# Watch resource usage (A1 instance has 24 GB — plenty)
docker stats
```

---

## 8. Update your README

Add this badge and section to the top of `README.md`:

```markdown
[![CI](https://github.com/<you>/pulseapi/actions/workflows/ci.yml/badge.svg)](https://github.com/<you>/pulseapi/actions)

**Live demo:** http://pulseapi.duckdns.org:3000/health
```

Interviewers at Razorpay, Postman, and AI startups will click that link. "Deployed and running in production" lands very differently from "runs locally."

---

## Architecture with Kafka (for system design discussions)

```
Client → PulseAPI Gateway
              │
              ├── [critical path] rate limit, auth, circuit breaker, proxy
              │
              └── publish to Kafka topic: request-logs
                         │
                    Kafka broker (KRaft, single-node for dev)
                         │
                  kafka-consumer (separate process)
                         │
                    batch INSERT → PostgreSQL
```

**Why this matters in interviews:**
- *Decoupling*: gateway latency is independent of Postgres write throughput
- *Durability*: Kafka retains messages during DB maintenance windows
- *Fan-out*: add an analytics consumer or SIEM without touching the gateway
- *Back-pressure visibility*: consumer lag is a first-class Kafka metric
- *Replay*: reprocess historical logs against a new schema without rerunning load tests
