const { WebSocketServer } = require('ws');
const { EventEmitter } = require('events');
const FrameDecoder = require('../shared/frameDecoder');
const { encodeFrame } = require('../shared/frameEncoder');
const { encryptMessage, decryptMessage, resetCryptoStream } = require('../shared/cryptoStream');
const crypto = require('crypto');

class TunnelServer extends EventEmitter {
    constructor(options = {}) {
        super();
        this.port = options.port || 8080;
        this.secret = options.secret;
        this.activeWs = null;
        this.wss = null;
        this.isAlive = false;
        this.pingInterval = null;

        this.secureHandshake = process.env.ENABLE_SECURE_HANDSHAKE === 'true';
        this.handshakeTimeoutLimit = process.env.HANDSHAKE_TIMEOUT_MS ? parseInt(process.env.HANDSHAKE_TIMEOUT_MS, 10) : 5 * 60 * 1000;
        this.usedNonces = new Map();
        // Clear used nonces periodically to prevent memory leaks, but only remove expired ones
        setInterval(() => this.cleanupExpiredNonces(), 60 * 1000); // Check every minute
    }

    start() {
        try {
            this.wss = new WebSocketServer({ port: this.port });
            console.log(`[TunnelServer] Listening for Raspberry Pi on port ${this.port}`);

            this.wss.on('error', (err) => {
                console.error(`[TunnelServer] WSS Error: ${err.message}`);
            });
        } catch (err) {
            console.error(`[TunnelServer] Failed to start server: ${err.message}`);
            throw err; // Re-throw to be caught by proxyServer.js
        }

        this.wss.on('connection', (ws, req) => {
            // Authentication
            if (this.secret) {
                if (this.secureHandshake) {
                    const timestamp = req.headers['x-tunnel-timestamp'];
                    const nonce = req.headers['x-tunnel-nonce'];
                    const signature = req.headers['x-tunnel-signature'];

                    if (!timestamp || !nonce || !signature) {
                        console.warn(`[TunnelServer] Rejected: Missing secure handshake headers`);
                        ws.close(1008, 'Unauthorized');
                        return;
                    }

                    // Allow configurable clock drift between Client and Server (Default 5 min)
                    if (Math.abs(Date.now() - parseInt(timestamp, 10)) > this.handshakeTimeoutLimit) {
                        console.warn(`[TunnelServer] Rejected: Timestamp drift too large`);
                        ws.close(1008, 'Unauthorized');
                        return;
                    }

                    if (this.usedNonces.has(nonce)) {
                        console.warn(`[TunnelServer] Rejected: Replay attack detected`);
                        ws.close(1008, 'Unauthorized');
                        return;
                    }

                    const expectedSignature = crypto.createHmac('sha256', this.secret).update(timestamp + nonce).digest('hex');
                    if (signature !== expectedSignature) {
                        console.warn(`[TunnelServer] Rejected: Invalid signature`);
                        ws.close(1008, 'Unauthorized');
                        return;
                    }

                    this.usedNonces.set(nonce, parseInt(timestamp, 10));
                } else {
                    const authHeader = req.headers['x-tunnel-secret'];
                    if (authHeader !== this.secret) {
                        console.warn(`[TunnelServer] Rejected connection from ${req.socket.remoteAddress}: Invalid secret`);
                        ws.close(1008, 'Unauthorized');
                        return;
                    }
                }
            }

            console.log(`[TunnelServer] Raspberry Pi connected from ${req.socket.remoteAddress}`);

            // If there's an existing connection, drop it
            if (this.activeWs) {
                console.log(`[TunnelServer] Dropping previous tunnel connection`);
                this.activeWs.close(1000, 'New connection established');
            }

            // Reset Sequence Counters for Replay Attack Prevention
            resetCryptoStream();

            this.activeWs = ws;
            const decoder = new FrameDecoder();

            decoder.on('error', (err) => {
                console.error(`[TunnelServer] Decoder error: ${err.message}`);
                ws.close(1008, 'Frame decoder error');
            });

            ws.on('message', (data) => {
                try {
                    const decrypted = decryptMessage(data);
                    decoder.push(decrypted);
                } catch (e) {
                    console.error(`[TunnelServer] Decryption failed, dropping connection: ${e.message}`);
                    ws.terminate();
                }
            });

            decoder.on('frame', (frame) => {
                this.emit('frame', frame);
            });

            ws.on('close', () => {
                if (this.activeWs === ws) {
                    console.log(`[TunnelServer] Raspberry Pi connection closed`);
                    this.activeWs = null;
                    clearInterval(this.pingInterval);
                    this.emit('tunnel_close');
                }
            });

            ws.on('error', (err) => {
                console.error(`[TunnelServer] WS Error: ${err.message}`);
            });

            // Heartbeat Logic
            this.isAlive = true;
            ws.on('pong', () => {
                this.isAlive = true;
            });

            if (this.pingInterval) clearInterval(this.pingInterval);
            this.pingInterval = setInterval(() => {
                if (!this.activeWs) return;
                if (this.isAlive === false) {
                    console.warn(`[TunnelServer] Ping timeout, terminating connection`);
                    this.activeWs.terminate();
                    return;
                }
                this.isAlive = false;
                this.activeWs.ping(); // standard ws ping frame
            }, 30000); // 30 seconds

            this.emit('tunnel_ready');
        });
    }

    cleanupExpiredNonces() {
        const now = Date.now();
        const expiry = this.handshakeTimeoutLimit + 60000; // Add 1min grace
        for (const [nonce, timestamp] of this.usedNonces.entries()) {
            if (now - timestamp > expiry) {
                this.usedNonces.delete(nonce);
            }
        }
    }

    /**
     * Send a frame to the tunnel
     */
    sendFrame(type, connectionId, payload = null) {
        if (!this.activeWs || this.activeWs.readyState !== 1) { // 1 = OPEN
            return false; // Tunnel not ready
        }

        const frame = encodeFrame(type, connectionId, payload);
        const encrypted = encryptMessage(frame);
        this.activeWs.send(encrypted, { binary: true });
        return true;
    }

    isReady() {
        return this.activeWs && this.activeWs.readyState === 1;
    }
}

module.exports = TunnelServer;
