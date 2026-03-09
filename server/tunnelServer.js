const { WebSocketServer } = require('ws');
const { EventEmitter } = require('events');
const FrameDecoder = require('../shared/frameDecoder');
const { encodeFrame } = require('../shared/frameEncoder');
const { encryptMessage, decryptMessage } = require('../shared/cryptoStream');

class TunnelServer extends EventEmitter {
    constructor(options = {}) {
        super();
        this.port = options.port || 8080;
        this.secret = options.secret;
        this.activeWs = null;
        this.wss = null;
        this.isAlive = false;
        this.pingInterval = null;
    }

    start() {
        this.wss = new WebSocketServer({ port: this.port });
        console.log(`[TunnelServer] Listening for Raspberry Pi on port ${this.port}`);

        this.wss.on('connection', (ws, req) => {
            // Basic authentication
            const authHeader = req.headers['x-tunnel-secret'];
            if (this.secret && authHeader !== this.secret) {
                console.warn(`[TunnelServer] Rejected connection from ${req.socket.remoteAddress}: Invalid secret`);
                ws.close(1008, 'Unauthorized');
                return;
            }

            console.log(`[TunnelServer] Raspberry Pi connected from ${req.socket.remoteAddress}`);

            // If there's an existing connection, drop it
            if (this.activeWs) {
                console.log(`[TunnelServer] Dropping previous tunnel connection`);
                this.activeWs.close(1000, 'New connection established');
            }

            this.activeWs = ws;
            const decoder = new FrameDecoder();

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
