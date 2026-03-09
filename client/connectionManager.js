const net = require('net');
const FrameDecoder = require('../shared/frameDecoder');
const { TYPES, encodeFrame } = require('../shared/frameEncoder');

class ConnectionManager {
    constructor(ws) {
        this.ws = ws;
        this.connections = new Map();
        this.decoder = new FrameDecoder();

        // Wire the decoder output to handle individual logic frames
        this.decoder.on('frame', (frame) => this.handleFrame(frame));
    }

    handleMessage(data) {
        // Feed raw chunks from WS to decoder
        this.decoder.push(data);
    }

    sendFrame(type, connId, payload = null) {
        if (this.ws.readyState === 1) { // 1 is WebSocket.OPEN
            this.ws.send(encodeFrame(type, connId, payload), { binary: true });
        }
    }

    handleFrame({ type, connectionId, payload }) {
        if (type === TYPES.OPEN) {
            if (!payload) return;
            const targetStr = payload.toString('utf8');
            const parts = targetStr.split(':');
            const host = parts[0];
            const port = parseInt(parts[1], 10) || 80;

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
                    // Implementing backpressure logic:
                    // If the socket buffer is full (returns false),
                    // we can pause the global tunnel WS to throttle the VPS flow.
                    // Note: A single slow TCP socket will throttle the entire tunnel
                    // in this implementation.
                    const wsSocket = this.ws._socket;
                    if (wsSocket) wsSocket.pause();

                    socket.once('drain', () => {
                        if (wsSocket) wsSocket.resume();
                    });
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
}

module.exports = ConnectionManager;
