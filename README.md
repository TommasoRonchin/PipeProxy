# PipeProxy 🚀

[![License: Apache 2.0](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)
[![Node.js Version](https://img.shields.io/badge/node-%3E%3D18.0.0-brightgreen.svg)](https://nodejs.org/)
[![Project Status: Production-Ready](https://img.shields.io/badge/Status-Production--Ready-success.svg)](#)
[![Security: AES-256-GCM](https://img.shields.io/badge/Security-AES--256--GCM-blueviolet.svg)](#)
[![Build Status](https://github.com/TommasoRonchin/PipeProxy/actions/workflows/ci.yml/badge.svg)](https://github.com/TommasoRonchin/PipeProxy/actions)

```text
  _____  _                _____                                
 |  __ \(_)              |  __ \                               
 | |__) |_ _ __   ___    | |__) | __ _____  ___   _            
 |  ___/| | '_ \ / _ \   |  ___/ '__/ _ \ \/ / | | |           
 | |    | | |_) |  __/   | |   | | | (_) >  <| |_| |           
 |_|    |_| .__/ \___|   |_|   |_|  \___/_/\_\\__, |           
          | |                                  __/ |           
          |_|                                 |___/            
```

**PipeProxy** is a high-performance, production-grade distributed HTTP/HTTPS Proxy system built in raw Node.js. 

### 💡 Why PipeProxy?

Most proxy solutions require complex VPN setups or exposed ports on your home network. **PipeProxy** flips the script:
- **No Port Forwarding**: Your home/IoT device connects *outbound* to the VPS.
- **Multiplexed**: Thousands of concurrent connections over a single WebSocket.
- **Zero-Trust**: Native AES-256-GCM encryption ensures your VPS provider can't sniff your traffic.
- **Lightweight**: Zero heavy dependencies. Runs perfectly on a Raspberry Pi Zero.
- **Resilient**: Implements "Happy Eyeballs" for seamless IPv6/v4 fallback.

---
## 🏗️ Architecture

- **Server A (Public VPS)**: Exposes a standard HTTP/HTTPS proxy port (e.g., `3128`).
- **Server B (Client Machine)**: Connects to the VPS via a secure WebSocket and performs the actual outbound TCP connections. This can be a Raspberry Pi, a Windows PC, or another Linux server anywhere in the world.
- **Multiplexing**: Thousands of proxy clients share the same single WebSocket tunnel using a lightning-fast custom 9-byte binary header protocol.
- **Resiliency**: Built-in Ping/Pong heartbeats, Head-of-Line blocking prevention, connection limits, and auto-reconnect logic.

---

## ⚙️ Installation

You will need Node.js installed on both the VPS and the target client device.

```bash
# Clone the repository
git clone https://github.com/TommasoRonchin/PipeProxy.git
cd PipeProxy

# Install dependencies (only uses 'ws' and 'dotenv')
npm install
```

---

## 🚀 Deployment

### 1. Server Configuration (VPS)

1. Copy the example environment file:
   ```bash
   cp .env.server.example .env
   ```
   > 💡 **Note on `.env` files**: The app prioritizes reading from a file named exactly `.env`. If it doesn't exist, it falls back to `.env.server` (or `.env.client` for the client node) so that you can run both on the same machine for testing.
2. Edit `.env.server` to customize the ports, the `TUNNEL_SECRET` (critical for security), and the proxy authentication credentials.
3. Start the server (preferably using pm2 or systemd for background execution):
   ```bash
   node server/proxyServer.js
   ```

### 2. Client Configuration (Home Network, Raspberry, PC)

1. Copy the example environment file:
   ```bash
   cp .env.client.example .env
   ```
2. Edit `.env` with the IP of your VPS (`SERVER_URL=ws://YOUR_VPS_IP:8080`) and the **exact same** `TUNNEL_SECRET` used on the server.
3. Start the client:
   ```bash
   node client/raspberryClient.js
   ```

### 3. Docker Deployment (Optional but Recommended)

You can easily run both components in isolated Docker containers to prevent environment clashes and ensure auto-restarts.

**On the VPS (Server):**
1. Copy and configure `.env.server`
2. Build and run the container:
   ```bash
   docker build -t pipeproxy-server -f Dockerfile.server .
   docker run -d --name pipeproxy-server \
     --restart unless-stopped \
     -p 3128:3128 -p 8080:8080 \
     --env-file .env.server \
     pipeproxy-server
   ```

**On the Raspberry Pi (Client):**
1. Copy and configure `.env.client`
2. Build and run the container:
   ```bash
   docker build -t pipeproxy-client -f Dockerfile.client .
   docker run -d --name pipeproxy-client \
     --restart unless-stopped \
     --env-file .env.client \
     pipeproxy-client
   ```

---

## 🔒 Usage & Testing

Once both nodes are running, you can connect to your VPS IP on the proxy port (e.g., `3128`). 
If you enabled Proxy Authentication, you must pass your credentials.

**Test via cURL:**
```bash
curl -U admin:securepassword123 -x http://YOUR_VPS_IP:3128 https://api.ipify.org
```
*If everything is configured correctly, it will return the IP address of your Raspberry Pi, not the VPS!*

---

## 🧪 Developing & Testing

PipeProxy comes with a gigantic comprehensive test suite that validates 31+ ultra-extreme scenarios including security exploits, load testing, and protocol integrity.

**Run All Tests:**
```bash
npm test
```
*Note: The tests will automatically spawn dummy backends and temporary server/client instances on high ports.*

---

## 🛠️ Advanced Features

- **Backpressure Handling:** The client and server track TCP buffer saturation. If a single destination socket fills beyond the `MAX_SOCKET_BUFFER_MB` (default 1MB) high-watermark, the specific stream is gracefully terminated without affecting the rest of the tunnel to prevent Out-Of-Memory crashes.
- **SSRF Protection:** Controlled by the `BLOCK_LOCAL_NETWORK` (default true) setting, the client natively prevents Server-Side Request Forgery by blocking incoming connection requests attempting to reach local IP ranges (`127.0.0.0/8`, `192.168.*`, `10.*`, etc.), protecting your home/corporate network.
- **Proxy Routing Security:** Plain HTTP proxied requests are forcefully decoupled using `FORCE_CONNECTION_CLOSE` (default true) to inject `Connection: close` headers. This prevents HTTP Keep-Alive proxy smuggling and routing confusion.
- **OOM Protection (Tunnel):** The built-in frame encoder natively limits frame generation chunk memory limits with `MAX_ENCODE_FRAME_SIZE_MB` (default 50). The built-in frame decoder protects against memory exhaustion attacks by strictly enforcing a `MAX_FRAME_SIZE` (default 10MB) on multiplexed payloads. Flow-control backpressure is also managed using `WS_HIGH_WATER_MARK_MB` (default 10) and `WS_LOW_WATER_MARK_MB` (default 2) which dynamically pause rapid local TCP sockets if the WebSocket tunnel struggles to keep up over slow connections.
- **OOM Protection (Proxy):** The proxy server strictly verifies headers avoiding infinite Slowloris buffer leaks via the `MAX_PROXY_HEADER_SIZE` (default 8KB) and `MAX_PROXY_TIMEOUT_MS` (default 10s) settings. Connections are also dropped if they stay idle for too long without exchanging data, controlled by `IDLE_TIMEOUT_MS` (default 60s). It also limits concurrent proxy connections with `MAX_CONCURRENT_PROXY_CONNECTIONS` (default 500).
- **Proxy Authentication:** Fully standard `Proxy-Authorization` header parsing implemented natively at the TCP packet level.
- **Hostname Validation:** The client enforces a `MAX_HOSTNAME_SIZE` (default 2KB) to prevent memory exhaustion from maliciously long target addresses. It also limits the number of targets queuing up for DNS resolution and early-data buffering using `MAX_PENDING_CONNECTIONS` (default 1000).
- **Zero-JSON Transport:** To maximize throughput, the system encodes routing metadata into a minimal `[ Type(1B) | ConnectionID(4B) | PayloadLength(4B) ]` binary buffer on top of the WebSocket payloads.
- **IPv6 & Happy Eyeballs:** Native support for IPv6 target addresses (e.g., `[::1]:80`). The client implements "Happy Eyeballs" (`autoSelectFamily` fallback) to transparently and instantly fallback to IPv4 if an IPv6 route is a "blackhole" (DNS resolves to IPv6 but the host lacks IPv6 internet connectivity), preventing infinite hangs.
- **Replay Attack Prevention (Advanced):** Strict sequence number tracking within GCM-encrypted frames ensures that intercepted packets cannot be replayed or dropped without triggering an immediate disconnect. Furthermore, rapid reconnections causing memory/service DoS (flapping) are prevented via the `RATE_LIMIT_MS` (default 1000ms) setting.

---

## 🛡️ Hardening Security

### 1. Secure Handshake (HMAC Challenge-Response)
By default, the tunnel secret would be transmitted in plaintext if you use a simple `ws://` connection. To prevent sniffing on local networks, PipeProxy uses a cryptographic Challenge-Response handshake to securely log in without ever sending the `TUNNEL_SECRET` over the wire. This is controlled by the `ENABLE_SECURE_HANDSHAKE=true` flag.

### 2. Secure Proxy Node Endpoint (Native TLS/HTTPS)

If you enable proxy authentication (`ENABLE_PROXY_AUTH`), the generic basic-auth credentials `PROXY_AUTH_USERNAME/PASSWORD` would normally transmit in plaintext HTTP. To encrypt the proxy node connection fully, you can enable native TLS directly in Node.js by setting `ENABLE_TLS_PROXY=true` on the VPS along with paths to your `.pem` files.
This converts your proxy server into a Secure HTTPS Proxy, ensuring nobody can intercept your proxy credentials. This is configured via `ENABLE_TLS_PROXY=true`, `TLS_CERT_PATH`, and `TLS_KEY_PATH`.

### 3. WSS / HTTPS (Stealth Layer for Production)

Even with native AES encryption enabled, using **WSS (WebSocket Secure)** is highly recommended for production environments. 

While our AES layer protects the **content** of your traffic, wrapping the tunnel in TLS (WSS) provides **Protocol Masking**:
- **Bypass Deep Packet Inspection (DPI)**: Standard TLS over port 443 makes your tunnel look like normal HTTPS browsing, preventing ISPs or corporate firewalls from throttling or blocking custom binary protocols.
- **Defense in Depth**: Provides an industry-standard encryption layer *around* our internal AES layer.
- **Identity Verification**: Ensures the client is definitely connecting to *your* VPS and not a middle-man.

We strongly recommend placing the VPS Tunnel Server behind a Reverse Proxy like **Nginx** or **Caddy** with a free SSL certificate from Let's Encrypt.

### How to Secure with Nginx:

1. Point a domain (e.g., `proxy.yourdomain.com`) to your VPS IP.
2. Install Nginx and Certbot on your VPS.
3. Add this configuration to Nginx to terminate SSL and forward traffic to PipeProxy's tunnel port (`8080`):

```nginx
server {
    listen 443 ssl;
    server_name proxy.yourdomain.com;

    ssl_certificate /etc/letsencrypt/live/proxy.yourdomain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/proxy.yourdomain.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "Upgrade";
        proxy_set_header Host $host;
        # Pass the custom authentication header
        proxy_set_header x-tunnel-secret $http_x_tunnel_secret;

        # Keep alive long-lived WebSocket streams (e.g. 24 hours instead of Nginx's default 60s)
        proxy_read_timeout 86400s;
        proxy_send_timeout 86400s;
        
        # Disable buffering to minimize latency for raw TCP streams
        proxy_buffering off;
    }
}
```

4. Once Nginx is running, update your Client's (Raspberry Pi) `.env` file to use the secure protocol:
   ```env
   SERVER_URL=wss://proxy.yourdomain.com
   ```

With this setup, the handshake, the `TUNNEL_SECRET`, and all multiplexed TCP packets are encrypted with military-grade TLS before they ever leave your Raspberry Pi!

---

### Alternative: Native AES-256-GCM Encryption (Zero Dependencies)
If you do not want to set up an external reverse proxy (Nginx or domains), PipeProxy includes a built-in zero-dependency AES-256-GCM streaming cypher layer natively. This mode validates payload integrity to prevent bit-flipping attacks.

By enabling this in your `.env` files:
```env
ENABLE_ENCRYPTION=true
ENCRYPTION_SECRET=some_super_long_custom_random_string
```
Every single multiplexed payload will be symmetrically encrypted natively in Node.js before being pushed through the `ws://` pipe. Any Middle-Man sniffing the WebSocket frames will only see random AES garbage bytes. Note: High-throughput connections (e.g. 500Mbps+) might slightly tax the Raspberry Pi CPU compared to kernel-level Nginx TLS.

### Environment Customization

You can fine-tune the system behavior by setting these environment variables in your `.env` file:

#### 🔐 Security & Handshake
- `ENABLE_SECURE_HANDSHAKE=true`: Enables Challenge-Response HMAC login (prevents replay/sniffing).
- `HANDSHAKE_TIMEOUT_MS=300000`: Allowed clock drift for secure handshakes (Default: 5 min).
- `MAX_NONCE_TRACKING_SIZE=100000`: Limits memory usage by capping the number of stored handshake nonces.
- `BLOCK_LOCAL_NETWORK=true`: (Client-only) Prevents SSRF by blocking connections to private/local IP ranges.
- `RATE_LIMIT_MS=1000`: Minimum time between tunnel reconnections to prevent flapping DoS.
- `STRICT_SEQUENCE_CHECK=true`: Rejects packets that arrive out of order (Encryption-only).
- `DEBUG_START_ID=1`: (Optional) Forces the connection counter to start at a high value to test 32-bit wrapping.

#### 🚀 Performance & Throughput
- `MAX_CONNECTIONS=2000`: Hard cap on parallel streams per tunnel.
- `MAX_CONCURRENT_PROXY_CONNECTIONS=500`: (Server-only) Max simultaneous public proxy clients.
- `PING_INTERVAL_MS=30000`: Heartbeat interval to detect and drop dead connections.
- `RECONNECT_DELAY_MS=3000`: (Client-only) Delay before attempting tunnel reconnection.
- `WS_HIGH_WATER_MARK_MB=10`: (Client-only) Buffer threshold to trigger backpressure throttling.
- `WS_LOW_WATER_MARK_MB=2`: (Client-only) Threshold to resume data flow after throttling.

#### 🛡️ Memory & OOM Protection
- `MAX_FRAME_SIZE=10485760`: Max allowed size (10MB) for a single multiplexed frame.
- `MAX_ENCODE_FRAME_SIZE_MB=50`: Safety limit for encoding outbound frame payloads.
- `MAX_SOCKET_BUFFER_MB=1`: Individual socket buffer limit before termination.
- `MAX_PROXY_HEADER_SIZE=8192`: (Server-only) Max HTTP header size for proxy clients.
- `MAX_PROXY_TIMEOUT_MS=10000`: (Server-only) Timeout for receiving initial proxy headers.
- `IDLE_TIMEOUT_MS=60000`: Timeout for connections that stay idle without data.
- `MAX_HOSTNAME_SIZE=2048`: (Client-only) Max length for target hostnames in OPEN frames.
- `MAX_PENDING_CONNECTIONS=1000`: (Client-only) Limit for connections waiting for DNS or early-data.

#### 🛠️ Routing Behavior
- `FORCE_CONNECTION_CLOSE=true`: (Server-only) Injects `Connection: close` to prevent smuggling.
- `REWRITE_PROXY_URLS=true`: (Server-only) Normalizes absolute proxy URLs to paths.
- `IPV4_FALLBACK_TIMEOUT_MS=250`: (Client-only) Wait time (in ms) before falling back from a dead IPv6 route to IPv4 (Happy Eyeballs).
