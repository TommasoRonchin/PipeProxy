const net = require('net');
const FrameDecoder = require('../shared/frameDecoder');
const { TYPES, encodeFrame } = require('../shared/frameEncoder');
const { encryptMessage } = require('../shared/cryptoStream');
const dns = require('dns');
const ipaddr = require('ipaddr.js');

class ConnectionManager {
    constructor(ws, cryptoStream) {
        this.ws = ws;
        this.cryptoStream = cryptoStream;
        this.connections = new Map();
        this.pendingConnections = new Map(); // Buffer early data while DNS resolves
        this.decoder = new FrameDecoder();

        const enableLimits = process.env.ENABLE_MAX_CONNECTIONS === 'true';
        this.maxConnections = enableLimits ? parseInt(process.env.MAX_CONNECTIONS || '2000', 10) : Infinity;

        const envMaxBuffer = parseInt(process.env.MAX_SOCKET_BUFFER_MB, 10);
        this.maxSocketBuffer = isNaN(envMaxBuffer) ? (1 * 1024 * 1024) : (envMaxBuffer * 1024 * 1024);

        const envMaxHostnameSize = parseInt(process.env.MAX_HOSTNAME_SIZE, 10);
        this.maxHostnameSize = isNaN(envMaxHostnameSize) ? 2048 : envMaxHostnameSize;

        this.maxPendingConnections = process.env.MAX_PENDING_CONNECTIONS ? parseInt(process.env.MAX_PENDING_CONNECTIONS, 10) : 1000;

        this.blockLocalNetwork = process.env.BLOCK_LOCAL_NETWORK !== 'false'; // Default to true for security

        // Websocket Backpressure Settings
        const envHighMem = parseInt(process.env.WS_HIGH_WATER_MARK_MB, 10);
        const envLowMem = parseInt(process.env.WS_LOW_WATER_MARK_MB, 10);
        this.wsHighWaterMark = isNaN(envHighMem) ? (10 * 1024 * 1024) : (envHighMem * 1024 * 1024); // Default 10MB
        this.wsLowWaterMark = isNaN(envLowMem) ? (2 * 1024 * 1024) : (envLowMem * 1024 * 1024);   // Default 2MB

        // Backpressure monitor loops
        this.drainInterval = setInterval(() => this.checkDrain(), 100);

        // Wire the decoder output to handle individual logic frames
        this.decoder.on('frame', (frame) => this.handleFrame(frame));

        this.decoder.on('error', (err) => {
            console.error(`[ConnectionManager] Decoder error: ${err.message}`);
            this.ws.close(1008, 'Frame decoder error');
        });
    }

    handleMessage(data) {
        // Feed raw chunks from WS to decoder
        this.decoder.push(data);
    }

    sendFrame(type, connId, payload = null) {
        if (this.ws.readyState === 1) { // 1 is WebSocket.OPEN
            try {
                const frame = encodeFrame(type, connId, payload);
                const encrypted = this.cryptoStream.encryptMessage(frame);
                this.ws.send(encrypted, { binary: true });
            } catch (e) {
                console.error(`[ConnectionManager] Error sending frame: ${e.message}`);
            }
        }
    }

    handleFrame({ type, connectionId, payload }) {
        if (type === TYPES.OPEN) {
            if (!payload) return;

            // Enforce Max Connections
            if ((this.connections.size + this.pendingConnections.size) >= this.maxConnections) {
                console.warn(`[ConnectionManager] Rejecting connection ${connectionId}: Max limit reached (${this.maxConnections})`);
                this.sendFrame(TYPES.CLOSE, connectionId);
                return;
            }

            // Enforce Max Pending Connections
            if (this.pendingConnections.size >= this.maxPendingConnections) {
                console.warn(`[ConnectionManager] Rejecting connection ${connectionId}: Max pending limit reached (${this.maxPendingConnections})`);
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
            const lastColonIdx = targetStr.lastIndexOf(':');
            let host;
            let port = 80;
            if (lastColonIdx !== -1 && (targetStr.indexOf(']') === -1 || targetStr.indexOf(']') < lastColonIdx)) {
                host = targetStr.substring(0, lastColonIdx);
                port = parseInt(targetStr.substring(lastColonIdx + 1), 10) || 80;
            } else {
                host = targetStr;
            }

            if (host.startsWith('[') && host.endsWith(']')) {
                host = host.substring(1, host.length - 1);
            }

            // Validate port to prevent unhandled RangeError from net.connect
            if (isNaN(port) || port <= 0 || port > 65535) {
                console.warn(`[ConnectionManager] Rejecting connection ${connectionId}: Invalid port ${port}`);
                this.sendFrame(TYPES.CLOSE, connectionId);
                return;
            }

            // SSRF Protection: Block access to local network IPs
            if (this.blockLocalNetwork && this.isLocalNetwork(host)) {
                console.warn(`[ConnectionManager] SSRF Attempt Blocked (Fast Check): Rejected connection to ${host}:${port}`);
                const response = `HTTP/1.1 403 Forbidden\r\nContent-Type: text/plain\r\nConnection: close\r\n\r\nSSRF Protection: Access to local network [${host}] is blocked.\n`;
                this.sendFrame(TYPES.DATA, connectionId, Buffer.from(response));
                this.sendFrame(TYPES.CLOSE, connectionId);
                return;
            }

            // Real SSRF Protection via DNS Resolution
            this.pendingConnections.set(connectionId, { queue: [], size: 0 }); // Init queue

            dns.lookup(host, { family: 0, all: true }, (err, addresses) => {
                // Check if connection was closed during DNS resolution
                if (!this.pendingConnections.has(connectionId)) {
                    console.log(`[DEBUG] DNS resolved for ${host} but connection ${connectionId} was already aborted.`);
                    return;
                }

                if (err || !addresses || addresses.length === 0) {
                    console.warn(`[ConnectionManager] Failed to resolve target host ${host}: ${err ? err.message : 'No addresses'}`);
                    const response = `HTTP/1.1 502 Bad Gateway\r\nContent-Type: text/plain\r\nConnection: close\r\n\r\nDNS Resolution Error: Could not resolve host [${host}].\n`;
                    this.sendFrame(TYPES.DATA, connectionId, Buffer.from(response));
                    this.sendFrame(TYPES.CLOSE, connectionId);
                    this.pendingConnections.delete(connectionId);
                    return;
                }

                // Format addresses properly for net.connect's custom lookup
                const validAddresses = addresses.map(a => ({ address: a.address, family: a.family }));
                console.log(`[DEBUG] DNS resolved ${host} -> `, validAddresses.map(a => a.address).join(', '));

                // SSRF Protection: Check all resolved IPs to prevent DNS Rebinding tricks
                for (const { address } of validAddresses) {
                    if (this.blockLocalNetwork && this.isProtectedIP(address)) {
                        console.warn(`[ConnectionManager] SSRF Attempt Blocked (DNS Check): Rejected connection to resolved IP ${address} for host ${host}`);
                        const response = `HTTP/1.1 403 Forbidden\r\nContent-Type: text/plain\r\nConnection: close\r\n\r\nSSRF Protection: Access to local network IP [${address}] is blocked.\n`;
                        this.sendFrame(TYPES.DATA, connectionId, Buffer.from(response));
                        this.sendFrame(TYPES.CLOSE, connectionId);
                        this.pendingConnections.delete(connectionId);
                        return;
                    }
                }

                // Create new socket connection using Happy Eyeballs (autoSelectFamily) 
                // We provide a custom lookup function returning OUR pre-verified validAddresses.
                // This prevents DNS Rebinding (since Node won't resolve again) and 
                // fixes the IPv6 "blackhole" hang by allowing Node to instantly fallback to IPv4.
                const socketOptions = {
                    host: host, // Pass original host for SNI / Host headers
                    port: port,
                    autoSelectFamily: true,
                    autoSelectFamilyAttemptTimeout: process.env.IPV4_FALLBACK_TIMEOUT_MS ? parseInt(process.env.IPV4_FALLBACK_TIMEOUT_MS, 10) : 250, // Default 250ms fallback to IPv4
                    lookup: (hostname, options, callback) => {
                        // If options.all is true, Node expects an array, else just the first address.
                        if (options.all) {
                            callback(null, validAddresses);
                        } else {
                            callback(null, validAddresses[0].address, validAddresses[0].family);
                        }
                    }
                };

                console.log(`[DEBUG] Calling net.connect to`, { host, port });
                const socket = net.connect(socketOptions, () => {
                    console.log(`[DEBUG] net.connect successful to ${host}:${port}`);
                    // Connected! Data stream will start naturally.
                    this.sendFrame(TYPES.OPEN_ACK, connectionId);
                });

                this.connections.set(connectionId, socket);

                // Replay buffered early data
                const pendingData = this.pendingConnections.get(connectionId);
                this.pendingConnections.delete(connectionId);
                if (pendingData && pendingData.queue.length > 0) {
                    for (const chunk of pendingData.queue) {
                        socket.write(chunk);
                    }
                }

                socket.on('data', (data) => {
                    // console.log(`[DEBUG] Received ${data.length} bytes from ${address}:${port}`);
                    this.sendFrame(TYPES.DATA, connectionId, data);

                    // Check if WebSocket buffer is getting too full
                    if (this.ws.bufferedAmount > this.wsHighWaterMark && !socket._isPausedByBackpressure) {
                        socket.pause();
                        socket._isPausedByBackpressure = true;
                        // console.warn(`[ConnectionManager] Pausing socket ${connectionId} due to WS backpressure`);
                    }
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
                    console.error(`[ConnectionManager] Target connection error for ${host}:${port}: ${err.message}`);
                    cleanup();
                });
            });

        } else if (type === TYPES.DATA) {
            console.log(`[DEBUG] Received DATA frame for ${connectionId}, length: ${payload ? payload.length : 0}`);
            const socket = this.connections.get(connectionId);
            if (socket) {
                if (socket.destroyed) {
                    this.sendFrame(TYPES.CLOSE, connectionId);
                    this.connections.delete(connectionId);
                    return;
                }
                if (payload && payload.length > 0) {
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
                }
            } else if (this.pendingConnections.has(connectionId)) {
                // Buffer early data until DNS/connect completes
                if (payload && payload.length > 0) {
                    const pendingData = this.pendingConnections.get(connectionId);
                    pendingData.queue.push(payload);
                    pendingData.size += payload.length;

                    // Prevent OOM: if the queued data exceeds the max socket buffer size
                    if (pendingData.size > this.maxSocketBuffer) {
                        console.warn(`[ConnectionManager] Destroying connection ${connectionId} due to massive early data buffer during DNS resolution.`);
                        this.sendFrame(TYPES.CLOSE, connectionId);
                        this.pendingConnections.delete(connectionId);
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
            if (this.pendingConnections.has(connectionId)) {
                this.pendingConnections.delete(connectionId);
            }
        }
    }

    closeAllConnections() {
        clearInterval(this.drainInterval);
        for (const [connId, socket] of this.connections) {
            socket.destroy();
        }
        this.connections.clear();
    }

    checkDrain() {
        // If the websocket buffer has drained below the low water mark, resume paused sockets
        if (this.ws && this.ws.readyState === 1 && this.ws.bufferedAmount <= this.wsLowWaterMark) {
            for (const [connId, socket] of this.connections) {
                if (socket._isPausedByBackpressure) {
                    socket._isPausedByBackpressure = false;
                    socket.resume();
                    // console.log(`[ConnectionManager] Resuming socket ${connId}`);
                }
            }
        }
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
                'uniqueLocal' // IPv6 private
            ];

            if (blockedRanges.includes(range)) {
                return true;
            }

            // Check for IPv4 mapped in IPv6
            if (addr.kind() === 'ipv6' && addr.isIPv4MappedAddress()) {
                const mappedIPv4 = addr.toIPv4Address();
                if (blockedRanges.includes(mappedIPv4.range())) {
                    return true;
                }
            }

            // Special handling for 0.0.0.0 and ::
            if (ipString === '0.0.0.0' || ipString === '::') {
                return true;
            }

            return false;
        } catch (e) {
            // Unparseable IP? Better block it to be safe.
            return true;
        }
    }
}

module.exports = ConnectionManager;
