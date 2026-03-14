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
        this.maxSocketBuffer = isNaN(envMaxBuffer) ? (10 * 1024 * 1024) : (envMaxBuffer * 1024 * 1024);

        const envMaxHostnameSize = parseInt(process.env.MAX_HOSTNAME_SIZE, 10);
        this.maxHostnameSize = isNaN(envMaxHostnameSize) ? 2048 : envMaxHostnameSize;

        this.maxPendingConnections = process.env.MAX_PENDING_CONNECTIONS ? parseInt(process.env.MAX_PENDING_CONNECTIONS, 10) : 1000;

        this.blockLocalNetwork = process.env.BLOCK_LOCAL_NETWORK !== 'false'; // Default to true for security

        // Websocket Backpressure Settings
        const envHighMem = parseInt(process.env.WS_HIGH_WATER_MARK_MB, 10);
        const envLowMem = parseInt(process.env.WS_LOW_WATER_MARK_MB, 10);
        this.wsHighWaterMark = isNaN(envHighMem) ? (64 * 1024 * 1024) : (envHighMem * 1024 * 1024); 
        this.wsLowWaterMark = isNaN(envLowMem) ? (16 * 1024 * 1024) : (envLowMem * 1024 * 1024);   

        const envMaxQueue = parseInt(process.env.MAX_CLIENT_QUEUE_MB, 10);
        this.maxQueueBytes = isNaN(envMaxQueue) ? (128 * 1024 * 1024) : (envMaxQueue * 1024 * 1024);
        this.outboundQueue = [];
        this.outboundQueueBytes = 0;
        this.isFlushingQueue = false;
        this.flushRetryTimer = null;

        // Backpressure monitor loops - Faster drain check
        this.drainInterval = setInterval(() => this.checkDrain(), 25);

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

                if (this.outboundQueueBytes + encrypted.length > this.maxQueueBytes) {
                    console.error('[ConnectionManager] Outbound queue overflow. Terminating websocket to recover from backpressure.');
                    this.ws.terminate();
                    return;
                }

                this.outboundQueue.push(encrypted);
                this.outboundQueueBytes += encrypted.length;
                this.flushOutboundQueue();
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

            const isIP = net.isIP(host);
            if (isIP) {
                const addresses = [{ address: host, family: isIP }];
                this.establishConnection(connectionId, host, port, addresses);
                return;
            }

            dns.lookup(host, { family: 0, all: true }, (err, addresses) => {
                if (!this.pendingConnections.has(connectionId)) return;

                if (err || !addresses || addresses.length === 0) {
                    console.warn(`[ConnectionManager] Failed to resolve target host ${host}: ${err ? err.message : 'No addresses'}`);
                    const response = `HTTP/1.1 502 Bad Gateway\r\nContent-Type: text/plain\r\nConnection: close\r\n\r\nDNS Resolution Error: Could not resolve host [${host}].\n`;
                    this.sendFrame(TYPES.DATA, connectionId, Buffer.from(response));
                    this.sendFrame(TYPES.CLOSE, connectionId);
                    this.pendingConnections.delete(connectionId);
                    return;
                }

                this.establishConnection(connectionId, host, port, addresses);
            });

        } else if (type === TYPES.DATA) {
            const socket = this.connections.get(connectionId);
            if (socket) {
                if (socket.destroyed) {
                    this.sendFrame(TYPES.CLOSE, connectionId);
                    this.connections.delete(connectionId);
                    return;
                }
                if (payload && payload.length > 0) {
                    if (!socket.write(payload)) {
                        if (socket.writableLength > this.maxSocketBuffer) {
                            console.warn(`[ConnectionManager] Destroying socket ${connectionId} due to massive backpressure buffer.`);
                            this.sendFrame(TYPES.CLOSE, connectionId);
                            socket.destroy();
                            this.connections.delete(connectionId);
                        }
                    }
                }
            } else if (this.pendingConnections.has(connectionId)) {
                if (payload && payload.length > 0) {
                    const pendingData = this.pendingConnections.get(connectionId);
                    pendingData.queue.push(payload);
                    pendingData.size += payload.length;

                    if (pendingData.size > this.maxSocketBuffer) {
                        console.warn(`[ConnectionManager] Destroying connection ${connectionId} due to massive early data buffer.`);
                        this.sendFrame(TYPES.CLOSE, connectionId);
                        this.pendingConnections.delete(connectionId);
                    }
                }
            } else {
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

    establishConnection(connectionId, host, port, validAddresses) {
        for (const { address } of validAddresses) {
            if (this.blockLocalNetwork && this.isProtectedIP(address)) {
                console.warn(`[ConnectionManager] SSRF Blocked (DNS Check): ${address}`);
                const response = `HTTP/1.1 403 Forbidden\r\nContent-Type: text/plain\r\nConnection: close\r\n\r\nSSRF Protection: Access to [${address}] blocked.\n`;
                this.sendFrame(TYPES.DATA, connectionId, Buffer.from(response));
                this.sendFrame(TYPES.CLOSE, connectionId);
                this.pendingConnections.delete(connectionId);
                return;
            }
        }

        const socketOptions = {
            host: host,
            port: port,
            autoSelectFamily: true,
            autoSelectFamilyAttemptTimeout: 250,
            lookup: (hostname, options, callback) => {
                if (options.all) callback(null, validAddresses);
                else callback(null, validAddresses[0].address, validAddresses[0].family);
            }
        };

        const socket = net.connect(socketOptions, () => {
            socket.setNoDelay(true);
            socket.setKeepAlive(true, 15000);
            this.sendFrame(TYPES.OPEN_ACK, connectionId);
        });

        this.connections.set(connectionId, socket);

        const pendingData = this.pendingConnections.get(connectionId);
        this.pendingConnections.delete(connectionId);
        if (pendingData && pendingData.queue.length > 0) {
            for (const chunk of pendingData.queue) {
                socket.write(chunk);
            }
        }

        socket.on('data', (data) => {
            this.sendFrame(TYPES.DATA, connectionId, data);
            if (this.ws.bufferedAmount > this.wsHighWaterMark && !socket._isPausedByBackpressure) {
                socket.pause();
                socket._isPausedByBackpressure = true;
            }
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
            console.error(`[ConnectionManager] Target error for ${host}:${port}: ${err.message}`);
            cleanup();
        });
    }

    closeAllConnections() {
        this.resetOutboundQueue();
        clearInterval(this.drainInterval);
        for (const [connId, socket] of this.connections) {
            socket.destroy();
        }
        this.connections.clear();
    }

    checkDrain() {
        if (this.ws && this.ws.readyState === 1 && this.ws.bufferedAmount <= this.wsLowWaterMark) {
            for (const [connId, socket] of this.connections) {
                if (socket._isPausedByBackpressure) {
                    socket._isPausedByBackpressure = false;
                    socket.resume();
                }
            }

            if (this.outboundQueue.length > 0) {
                this.flushOutboundQueue();
            }
        }
    }

    flushOutboundQueue() {
        if (this.isFlushingQueue) return;
        if (!this.ws || this.ws.readyState !== 1) return;
        if (this.outboundQueue.length === 0) return;

        if (this.ws.bufferedAmount > this.wsHighWaterMark) {
            if (!this.flushRetryTimer) {
                this.flushRetryTimer = setTimeout(() => {
                    this.flushRetryTimer = null;
                    this.flushOutboundQueue();
                }, 5);
            }
            return;
        }

        this.isFlushingQueue = true;
        const chunk = this.outboundQueue.shift();

        try {
            this.ws.send(chunk, { binary: true }, (err) => {
            this.isFlushingQueue = false;
            this.outboundQueueBytes -= chunk.length;
            if (this.outboundQueueBytes < 0) this.outboundQueueBytes = 0;

            if (err) {
                console.error(`[ConnectionManager] WS send failed: ${err.message}`);
                if (this.ws && this.ws.readyState === 1) {
                    this.ws.terminate();
                }
                return;
            }

            if (this.outboundQueue.length > 0) {
                setImmediate(() => this.flushOutboundQueue());
            }
            });
        } catch (err) {
            this.isFlushingQueue = false;
            this.outboundQueueBytes -= chunk.length;
            if (this.outboundQueueBytes < 0) this.outboundQueueBytes = 0;
            console.error(`[ConnectionManager] WS send threw: ${err.message}`);
            if (this.ws && this.ws.readyState === 1) {
                this.ws.terminate();
            }
        }
    }

    resetOutboundQueue() {
        this.outboundQueue = [];
        this.outboundQueueBytes = 0;
        this.isFlushingQueue = false;
        if (this.flushRetryTimer) {
            clearTimeout(this.flushRetryTimer);
            this.flushRetryTimer = null;
        }
    }

    isLocalNetwork(host) {
        if (!host) return true;
        host = host.toLowerCase();
        if (host === 'localhost' || host === '127.0.0.1' || host === '::1' || host.endsWith('.localhost')) return true;
        if (host.startsWith('10.') || host.startsWith('192.168.') || host.startsWith('169.254.')) return true;
        if (host.startsWith('172.')) {
            const secondOctet = parseInt(host.split('.')[1], 10);
            if (secondOctet >= 16 && secondOctet <= 31) return true;
        }
        if (host.startsWith('fc') || host.startsWith('fd') || host.startsWith('fe80:')) return true;
        if (host === '0.0.0.0' || host === '::' || host === '0') return true;
        return false;
    }

    isProtectedIP(ipString) {
        try {
            const addr = ipaddr.parse(ipString);
            const range = addr.range();
            const blockedRanges = ['unspecified', 'broadcast', 'multicast', 'linkLocal', 'loopback', 'private', 'reserved', 'carrierGradeNat', 'uniqueLocal'];
            if (blockedRanges.includes(range)) return true;
            if (addr.kind() === 'ipv6' && addr.isIPv4MappedAddress()) {
                const mappedIPv4 = addr.toIPv4Address();
                if (blockedRanges.includes(mappedIPv4.range())) return true;
            }
            if (ipString === '0.0.0.0' || ipString === '::') return true;
            return false;
        } catch (e) { return true; }
    }
}

module.exports = ConnectionManager;
