const { WebSocketServer } = require('ws');
const { EventEmitter } = require('events');
const FrameDecoder = require('../shared/frameDecoder');
const { encodeFrame } = require('../shared/frameEncoder');

class TunnelServer extends EventEmitter {
    constructor(options = {}) {
        super();
        this.port = options.port || 8080;
        this.secret = options.secret;
        this.activeWs = null;
        this.wss = null;
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
                decoder.push(data);
            });

            decoder.on('frame', (frame) => {
                this.emit('frame', frame);
            });

            ws.on('close', () => {
                if (this.activeWs === ws) {
                    console.log(`[TunnelServer] Raspberry Pi connection closed`);
                    this.activeWs = null;
                    this.emit('tunnel_close');
                }
            });

            ws.on('error', (err) => {
                console.error(`[TunnelServer] WS Error: ${err.message}`);
            });

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
        this.activeWs.send(frame, { binary: true });
        return true;
    }

    isReady() {
        return this.activeWs && this.activeWs.readyState === 1;
    }
}

module.exports = TunnelServer;
