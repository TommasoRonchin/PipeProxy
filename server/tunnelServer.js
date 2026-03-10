const { WebSocketServer } = require('ws');
const { EventEmitter } = require('events');
const FrameDecoder = require('../shared/frameDecoder');
const { encodeFrame } = require('../shared/frameEncoder');
const { encryptMessage, decryptMessage, timingSafeEqual, CryptoStream } = require('../shared/cryptoStream');
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
        this.maxNonceTrackingSize = process.env.MAX_NONCE_TRACKING_SIZE ? parseInt(process.env.MAX_NONCE_TRACKING_SIZE, 10) : 100000;

        // Per-connection crypto stream (initialized on connection)
        this.cryptoStream = null;

        // Clear used nonces periodically to prevent memory leaks, but only remove expired ones
        this.nonceCleanupInterval = setInterval(() => this.cleanupExpiredNonces(), 60 * 1000); // Check every minute
    }

    async start() {
        return new Promise((resolve, reject) => {
            try {
                this.wss = new WebSocketServer({ port: this.port });

                const onStartupError = (err) => {
                    this.wss.removeListener('listening', onListening);
                    reject(err);
                };

                const onListening = () => {
                    this.wss.removeListener('error', onStartupError);
                    console.log(`[TunnelServer] Listening for Raspberry Pi on port ${this.port}`);
                    resolve();
                };

                this.wss.once('error', onStartupError);
                this.wss.once('listening', onListening);

                // For future errors after successful startup
                this.wss.on('error', (err) => {
                    console.error(`[TunnelServer] WSS Runtime Error: ${err.message}`);
                    this.emit('error', err);
                });

            } catch (err) {
                reject(err);
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

                        if (this.usedNonces.size >= this.maxNonceTrackingSize) {
                            console.warn(`[TunnelServer] Rejected: Nonce tracking limit reached (DoS protection)`);
                            ws.close(1008, 'Server Busy');
                            return;
                        }

                        const expectedSignature = crypto.createHmac('sha256', this.secret).update(timestamp + nonce).digest('hex');
                        if (!timingSafeEqual(signature, expectedSignature)) {
                            console.warn(`[TunnelServer] Rejected: Invalid signature`);
                            ws.close(1008, 'Unauthorized');
                            return;
                        }

                        this.usedNonces.set(nonce, parseInt(timestamp, 10));
                    } else {
                        const authHeader = req.headers['x-tunnel-secret'];
                        if (!timingSafeEqual(authHeader, this.secret)) {
                            console.warn(`[TunnelServer] Rejected connection from ${req.socket.remoteAddress}: Invalid secret`);
                            ws.close(1008, 'Unauthorized');
                            return;
                        }
                    }
                }

                console.log(`[TunnelServer] Raspberry Pi connected from ${req.socket.remoteAddress}`);

                // Rate limiting to prevent DoS by rapid connection flapping
                const RATE_LIMIT_MS = process.env.RATE_LIMIT_MS ? parseInt(process.env.RATE_LIMIT_MS, 10) : 1000;
                const now = Date.now();
                if (this.lastConnectionTime && (now - this.lastConnectionTime < RATE_LIMIT_MS)) {
                    console.warn(`[TunnelServer] Rate limiting tunnel connection from ${req.socket.remoteAddress} (flapping detected)`);
                    ws.close(1008, 'Rate limited');
                    return;
                }
                this.lastConnectionTime = now;

                // If there's an existing connection, drop it
                if (this.activeWs) {
                    console.log(`[TunnelServer] Dropping previous tunnel connection`);
                    this.activeWs.close(1000, 'New connection established');
                }

                // Initialize/Reset Crypto Stream for the new connection
                this.cryptoStream = new CryptoStream({
                    enableEncryption: process.env.ENABLE_ENCRYPTION === 'true',
                    secret: process.env.ENCRYPTION_SECRET,
                    strictSequence: process.env.STRICT_SEQUENCE_CHECK !== 'false'
                });

                this.activeWs = ws;
                const decoder = new FrameDecoder();

                decoder.on('error', (err) => {
                    console.error(`[TunnelServer] Decoder error: ${err.message}`);
                    ws.close(1008, 'Frame decoder error');
                });

                ws.on('message', (data) => {
                    try {
                        const decrypted = this.cryptoStream.decryptMessage(data);
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
        });
    }

    stop() {
        if (this.nonceCleanupInterval) {
            clearInterval(this.nonceCleanupInterval);
            this.nonceCleanupInterval = null;
        }
        if (this.pingInterval) {
            clearInterval(this.pingInterval);
            this.pingInterval = null;
        }
        if (this.wss) {
            this.wss.close();
            this.wss = null;
        }
        if (this.activeWs) {
            this.activeWs.terminate();
            this.activeWs = null;
        }
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
        const encrypted = this.cryptoStream.encryptMessage(frame);
        this.activeWs.send(encrypted, { binary: true });
        return true;
    }

    isReady() {
        return this.activeWs && this.activeWs.readyState === 1;
    }
}

module.exports = TunnelServer;
