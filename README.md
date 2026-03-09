# PipeProxy 🚀

A high-performance, production-grade distributed HTTP/HTTPS Proxy system built in raw Node.js. 

PipeProxy allows you to route proxy traffic through a client located behind a NAT (like a Raspberry Pi at home), by keeping a persistent multiplexed WebSocket tunnel connected to a public VPS.

## 🏗️ Architecture

- **Server A (Public VPS)**: Exposes a standard HTTP/HTTPS proxy port (e.g., `3128`).
- **Server B (Raspberry Pi)**: Connects to the VPS via a secure WebSocket and performs the actual outbound TCP connections.
- **Multiplexing**: Thousands of proxy clients share the same single WebSocket tunnel using a lightning-fast custom 9-byte binary header protocol.
- **Resiliency**: Built-in Ping/Pong heartbeats, Head-of-Line blocking prevention, connection limits, and auto-reconnect logic.

---

## ⚙️ Installation

You will need Node.js installed on both the VPS and the target device (Raspberry Pi).

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
   cp .env.server.example .env.server
   ```
2. Edit `.env.server` to customize the ports, the `TUNNEL_SECRET` (critical for security), and the proxy authentication credentials.
3. Start the server (preferably using pm2 or systemd for background execution):
   ```bash
   node server/proxyServer.js
   ```

### 2. Client Configuration (Raspberry Pi/Home Network)

1. Copy the example environment file:
   ```bash
   cp .env.client.example .env.client
   ```
2. Edit `.env.client` with the IP of your VPS (`SERVER_URL=ws://YOUR_VPS_IP:8080`) and the **exact same** `TUNNEL_SECRET` used on the server.
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

## 🛠️ Advanced Features

- **Backpressure Handling:** The client tracks TCP buffer saturation. If a single destination socket fills beyond 5MB of high-watermark, the specific stream is gracefully terminated without affecting the rest of the tunnel.
- **Proxy Authentication:** Fully standard `Proxy-Authorization` header parsing implemented natively at the TCP packet level.
- **Zero-JSON Transport:** To maximize throughput, the system encodes routing metadata into a minimal `[ Type(1B) | ConnectionID(4B) | PayloadLength(4B) ]` binary buffer on top of the WebSocket payloads.
