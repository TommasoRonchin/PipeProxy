const net = require('net');
const FrameDecoder = require('../shared/frameDecoder');
const { TYPES, encodeFrame } = require('../shared/frameEncoder');
const { encryptMessage } = require('../shared/cryptoStream');
const dns = require('dns');
const ipaddr = require('ipaddr.js');

class ConnectionManager {
    constructor(ws) {
        this.ws = ws;
        this.connections = new Map();
        this.pendingConnections = new Map(); // Buffer early data while DNS resolves
        this.decoder = new FrameDecoder();

        const enableLimits = process.env.ENABLE_MAX_CONNECTIONS === 'true';
        this.maxConnections = enableLimits ? parseInt(process.env.MAX_CONNECTIONS || '2000', 10) : Infinity;

        const envMaxBuffer = parseInt(process.env.MAX_SOCKET_BUFFER_MB, 10);
        this.maxSocketBuffer = isNaN(envMaxBuffer) ? (1 * 1024 * 1024) : (envMaxBuffer * 1024 * 1024);

        const envMaxHostnameSize = parseInt(process.env.MAX_HOSTNAME_SIZE, 10);
        this.maxHostnameSize = isNaN(envMaxHostnameSize) ? 2048 : envMaxHostnameSize;

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

            // Hostname DoS Protection: Prevent massive payloads from allocating too much memory
            if (payload.length > this.maxHostnameSize) {
                console.warn(`[ConnectionManager] Rejecting connection ${connectionId}: Hostname payload too large (${payload.length} bytes, limit is ${this.maxHostnameSize})`);
                this.sendFrame(TYPES.CLOSE, connectionId);
                return;
            }

            const targetStr = payload.toString('utf8');
            const parts = targetStr.split(':');
            const host = parts[0];
            const port = parseInt(parts[1], 10) || 80;

            // SSRF Protection: Block access to local network IPs
            if (this.blockLocalNetwork && this.isLocalNetwork(host)) {
                console.warn(`[ConnectionManager] SSRF Attempt Blocked (Fast Check): Rejected connection to ${host}:${port}`);
                this.sendFrame(TYPES.CLOSE, connectionId);
                return;
            }

            // Real SSRF Protection via DNS Resolution
            this.pendingConnections.set(connectionId, []); // Init queue

            dns.lookup(host, { family: 4 }, (err, address, family) => {
                if (err) {
                    console.warn(`[ConnectionManager] Failed to resolve target host ${host}: ${err.message}`);
                    this.sendFrame(TYPES.CLOSE, connectionId);
                    this.pendingConnections.delete(connectionId);
                    return;
                }

                console.log(`[DEBUG] DNS resolved ${host} -> ${address} (family: ${family})`);

                if (this.blockLocalNetwork && this.isProtectedIP(address)) {
                    console.warn(`[ConnectionManager] SSRF Attempt Blocked (DNS Check): Rejected connection to resolved IP ${address} for host ${host}`);
                    this.sendFrame(TYPES.CLOSE, connectionId);
                    return;
                }

                // Create new socket connection to the requested target using the resolved safe IP
                const socketOptions = { host: address, port };
                if (family === 4 || family === 6) socketOptions.family = family;

                console.log(`[DEBUG] Calling net.connect to`, socketOptions);
                const socket = net.connect(socketOptions, () => {
                    console.log(`[DEBUG] net.connect successful to ${address}:${port}`);
                    // Connected! Data stream will start naturally.
                });

                this.connections.set(connectionId, socket);

                // Replay buffered early data
                const queuedData = this.pendingConnections.get(connectionId);
                this.pendingConnections.delete(connectionId);
                if (queuedData && queuedData.length > 0) {
                    for (const chunk of queuedData) {
                        socket.write(chunk);
                    }
                }

                socket.on('data', (data) => {
                    console.log(`[DEBUG] Received ${data.length} bytes from ${address}:${port}`);
                    this.sendFrame(TYPES.DATA, connectionId, data);
                });

                const cleanup = () => {
                    console.log(`[DEBUG] socket cleanup called for ${connectionId}`);
                    if (this.connections.has(connectionId)) {
                        this.sendFrame(TYPES.CLOSE, connectionId);
                        this.connections.delete(connectionId);
                    }
                };

                socket.on('end', () => { console.log(`[DEBUG] socket end for ${connectionId}`); cleanup(); });
                socket.on('close', (hadError) => { console.log(`[DEBUG] socket close for ${connectionId}, hadError: ${hadError}`); cleanup(); });

                socket.on('error', (err) => {
                    console.error(`[DEBUG] Target connection error for ${host}:${port}: ${err.message}`);
                    cleanup();
                });
            });

        } else if (type === TYPES.DATA) {
            console.log(`[DEBUG] Received DATA frame for ${connectionId}, length: ${payload ? payload.length : 0}`);
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
            } else if (this.pendingConnections.has(connectionId)) {
                // Buffer early data until DNS/connect completes
                this.pendingConnections.get(connectionId).push(payload);
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
            if (this.pendingConnections.has(connectionId)) {
                this.pendingConnections.delete(connectionId);
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
        // Simple string matching for known private IP ranges and localhost (fast preliminary check)
        if (!host) return true;

        host = host.toLowerCase();
        if (host === 'localhost' || host === '127.0.0.1' || host === '::1' || host.endsWith('.localhost')) {
            return true;
        }

        // IPv4 typical private networks string check
        if (host.startsWith('10.') || host.startsWith('192.168.') || host.startsWith('169.254.')) {
            return true;
        }

        if (host.startsWith('172.')) {
            const secondOctet = parseInt(host.split('.')[1], 10);
            if (secondOctet >= 16 && secondOctet <= 31) return true;
        }

        // Catch IPv6 local/private addresses string check
        if (host.startsWith('fc') || host.startsWith('fd') || host.startsWith('fe80:')) {
            return true;
        }

        // Additional strict checks against null/any IPs which some OSes treat as localhost
        if (host === '0.0.0.0' || host === '::' || host === '0') {
            return true;
        }

        return false;
    }

    isProtectedIP(ipString) {
        try {
            const addr = ipaddr.parse(ipString);
            const range = addr.range();

            // ipaddr.js returns predefined strings for well-known networks
            const blockedRanges = [
                'unspecified',
                'broadcast',
                'multicast',
                'linkLocal',
                'loopback',
                'private',
                'reserved',
                'carrierGradeNat',
                'uniqueLocal', // IPv6 private
                'ipv4Mapped' // e.g. ::ffff:127.0.0.1
            ];

            if (blockedRanges.includes(range)) {
                return true;
            }

            // For ipv4Mapped addresses, we must also check the underlying IPv4 address
            if (range === 'ipv4Mapped' && addr.kind() === 'ipv6') {
                const mappedIPv4 = addr.toIPv4Address();
                if (blockedRanges.includes(mappedIPv4.range())) {
                    return true;
                }
            }

            return false;
        } catch (e) {
            // Unparseable IP? Better block it to be safe.
            return true;
        }
    }
}

module.exports = ConnectionManager;
