# Deploy a Relay Node

A relay helps agents on different networks (home WiFi, office, cloud)
find and reach each other. Deploy this on a $5/month VM and your agents
can connect from anywhere.

## Step 1: Rent a VM

Any cloud provider works:

- **DigitalOcean**: $5/month droplet (1GB RAM, 25GB SSD)
- **Linode/Akamai**: $5/month nanode (1GB RAM, 25GB SSD)
- **Vultr**: $5/month instance (1GB RAM, 25GB SSD)
- **AWS**: t3.micro ($8-10/month)

Requirements:
- Ubuntu 22.04+ or Debian 12+
- 1GB RAM minimum
- Open UDP port 4434

## Step 2: Install Docker

```bash
# SSH into your VM, then:
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER
# Log out and back in for the group change to take effect
```

## Step 3: Deploy the Relay

```bash
# Clone the repo
git clone https://github.com/davidnichols-ops/AAFP-research.git
cd AAFP-research/examples/relay-setup

# Start the relay
docker compose up -d
```

**Expected output:**

```
[+] Running 2/2
 ✔ Network relay-setup_default  Created
 ✔ Container aafp-relay         Started
```

## Step 4: Verify It's Running

From your local machine:

```bash
./implementations/rust/target/release/aafp health --addr quic://YOUR_VM_IP:4434
```

**Expected output:**

```
Status: healthy
```

## Step 5: Use the Relay

Agents can now use the relay to reach each other:

```bash
# On machine A (e.g. your laptop):
aafp serve --capability echo --relay quic://YOUR_VM_IP:4434

# On machine B (e.g. office computer):
aafp call echo "hello" --addr quic://MACHINE_A_ADDR
```

## Manage the Relay

```bash
# View logs
docker compose logs -f relay

# Restart
docker compose restart

# Stop
docker compose down

# Update to latest version
git pull
docker compose up -d --build
```

## How It Works

The relay runs an AAFP agent in relay mode. When two agents on different
networks want to connect, they both contact the relay, which helps them
establish a direct connection (or relays traffic if a direct connection
isn't possible).

The relay doesn't see your message content — AAFP uses end-to-end
encryption, so only the sender and receiver can read messages.
