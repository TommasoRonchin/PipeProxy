const net = require('net');
const FrameDecoder = require('../shared/frameDecoder');
const { TYPES, encodeFrame } = require('../shared/frameEncoder');
const { encryptMessage } = require('../shared/cryptoStream');

class ConnectionManager {
    constructor(ws) {
        this.ws = ws;
        this.connections = new Map();
        this.decoder = new FrameDecoder();

        const enableLimits = process.env.ENABLE_MAX_CONNECTIONS === 'true';
        this.maxConnections = enableLimits ? parseInt(process.env.MAX_CONNECTIONS || '2000', 10) : Infinity;

        const envMaxBuffer = parseInt(process.env.MAX_SOCKET_BUFFER_MB, 10);
        this.maxSocketBuffer = isNaN(envMaxBuffer) ? (1 * 1024 * 1024) : (envMaxBuffer * 1024 * 1024);

        this.blockLocalNetwork = process.env.BLOCK_LOCAL_NETWORK !== 'false'; // Default to true for security

        // Wire the decoder output to handle individual logic frames
        this.decoder.on('frame', (frame) => this.handleFrame(frame));
    }

    handleMessage(data) {
        // Feed raw chunks from WS to decoder
        this.decoder.push(data);
    }

    sendFrame(type, connId, payload = null) {
        if (this.ws.readyState === 1) { // 1 is WebSocket.OPEN
            const frame = encodeFrame(type, connId, payload);
            const encrypted = encryptMessage(frame);
            this.ws.send(encrypted, { binary: true });
        }
    }

    handleFrame({ type, connectionId, payload }) {
        if (type === TYPES.OPEN) {
            if (!payload) return;

            // Enforce Max Connections
            if (this.connections.size >= this.maxConnections) {
                console.warn(`[ConnectionManager] Rejecting connection ${connectionId}: Max limit reached (${this.maxConnections})`);
                this.sendFrame(TYPES.CLOSE, connectionId);
                return;
            }

            const targetStr = payload.toString('utf8');
            const parts = targetStr.split(':');
            const host = parts[0];
            const port = parseInt(parts[1], 10) || 80;

            // SSRF Protection: Block access to local network IPs
            if (this.blockLocalNetwork && this.isLocalNetwork(host)) {
                console.warn(`[ConnectionManager] SSRF Attempt Blocked: Rejected connection to local network ${host}:${port}`);
                this.sendFrame(TYPES.CLOSE, connectionId);
                return;
            }

            // Create new socket connection to the requested target
            const socket = net.connect({ host, port }, () => {
                // Connected! Data stream will start naturally.
            });

            this.connections.set(connectionId, socket);

            socket.on('data', (data) => {
                this.sendFrame(TYPES.DATA, connectionId, data);
            });

            const cleanup = () => {
                if (this.connections.has(connectionId)) {
                    this.sendFrame(TYPES.CLOSE, connectionId);
                    this.connections.delete(connectionId);
                }
            };

            socket.on('end', cleanup);
            socket.on('close', cleanup);

            socket.on('error', (err) => {
                // console.error(`[ConnectionManager] Target connection error for ${host}:${port}: ${err.message}`);
                cleanup();
            });

        } else if (type === TYPES.DATA) {
            const socket = this.connections.get(connectionId);
            if (socket) {
                if (!socket.write(payload)) {
                    // Head-of-Line Blocking fix: 
                    // Instead of pausing the ENTIRE websocket tunnel (which blocks ALL connections),
                    // we tell the VPS to stop sending data FOR THIS SPECIFIC connection.
                    // We can do this by sending a custom PAUSE frame, but for simplicity 
                    // we can rely on standard OS TCP buffers up to a point, or if we want to be strict,
                    // we would need a WINDOW_UPDATE protocol.
                    // For now, removing `wsSocket.pause()` prevents the tunnel from freezing completely
                    // on one slow connection, allowing other streams to continue flowing smoothly while
                    // Node handles backpressure natively by buffering in memory up to `highWaterMark`.
                    // We can optionally destroy the socket if its buffer becomes absurdly large:
                    if (socket.writableLength > this.maxSocketBuffer) { // Buffer limit per socket
                        console.warn(`[ConnectionManager] Destroying socket ${connectionId} due to massive backpressure buffer.`);
                        this.sendFrame(TYPES.CLOSE, connectionId);
                        socket.destroy();
                        this.connections.delete(connectionId);
                    }
                }
            } else {
                // Drop extra data and tell remote that we are closed.
                this.sendFrame(TYPES.CLOSE, connectionId);
            }

        } else if (type === TYPES.CLOSE) {
            const socket = this.connections.get(connectionId);
            if (socket) {
                socket.destroy();
                this.connections.delete(connectionId);
            }
        }
    }

    closeAllConnections() {
        for (const [connId, socket] of this.connections) {
            socket.destroy();
        }
        this.connections.clear();
    }

    isLocalNetwork(host) {
        // Simple string matching for known private IP ranges and localhost
        if (!host) return true;

        host = host.toLowerCase();
        if (host === 'localhost' || host === '127.0.0.1' || host === '::1' || host.endsWith('.localhost')) {
            return true;
        }

        // IPv4 typical private networks
        if (host.startsWith('10.') || host.startsWith('192.168.') || host.startsWith('169.254.')) {
            return true;
        }

        if (host.startsWith('172.')) {
            const secondOctet = parseInt(host.split('.')[1], 10);
            if (secondOctet >= 16 && secondOctet <= 31) return true;
        }

        // Catch IPv6 local/private addresses
        if (host.startsWith('fc') || host.startsWith('fd') || host.startsWith('fe80:')) {
            return true;
        }

        return false;
    }
}

module.exports = ConnectionManager;
