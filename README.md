# PipeProxy 🚀

A high-performance, production-grade distributed HTTP/HTTPS Proxy system built in raw Node.js. 

PipeProxy allows you to route proxy traffic through an external client (such as a Raspberry Pi at home, another server, or a PC) that sits behind a NAT, by keeping a persistent multiplexed WebSocket tunnel connected to a public VPS.

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

## 🛠️ Advanced Features

- **Backpressure Handling:** The client tracks TCP buffer saturation. If a single destination socket fills beyond 5MB of high-watermark, the specific stream is gracefully terminated without affecting the rest of the tunnel.
- **Proxy Authentication:** Fully standard `Proxy-Authorization` header parsing implemented natively at the TCP packet level.
- **Zero-JSON Transport:** To maximize throughput, the system encodes routing metadata into a minimal `[ Type(1B) | ConnectionID(4B) | PayloadLength(4B) ]` binary buffer on top of the WebSocket payloads.

---

## 🛡️ Hardening Security (WSS / HTTPS)

By default, the tunnel runs on `ws://` (unencrypted WebSocket). While the `TUNNEL_SECRET` prevents unauthorized access, **the token itself and your proxy traffic travel in plaintext** and can be intercepted by anyone sniffing the network (e.g. your ISP or a public WiFi).

To make the tunnel **100% secure and uninterceptable**, you must use **WSS (WebSocket Secure)**. 
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

### Alternative: Native AES-256 Encryption (Zero Dependencies)
If you do not want to set up an external reverse proxy (Nginx or domains), PipeProxy includes a built-in zero-dependency AES-256-CTR streaming cypher layer natively.

By enabling this in your `.env` files:
```env
ENABLE_ENCRYPTION=true
ENCRYPTION_SECRET=some_super_long_custom_random_string
```
Every single multiplexed payload will be symmetrically encrypted natively in Node.js before being pushed through the `ws://` pipe. Any Middle-Man sniffing the WebSocket frames will only see random AES garbage bytes. Note: High-throughput connections (e.g. 500Mbps+) might slightly tax the Raspberry Pi CPU compared to kernel-level Nginx TLS.
