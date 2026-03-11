const { TYPES } = require('../shared/frameEncoder');
const { EventEmitter } = require('events');

class FrameProtocol extends EventEmitter {
    constructor(tunnelServer) {
        super();
        this.setMaxListeners(0); // unlimited listeners to silence Node.js warning in high-concurrency environments (events are fully managed)
        this.tunnelServer = tunnelServer;
        // Map of connectionId -> socket
        this.connections = new Map();
        this.nextConnectionId = 1;

        const envMaxBuffer = parseInt(process.env.MAX_SOCKET_BUFFER_MB, 10);
        this.maxSocketBuffer = isNaN(envMaxBuffer) ? (1 * 1024 * 1024) : (envMaxBuffer * 1024 * 1024);

        // Listen to incoming frames from the tunnel
        this.tunnelServer.on('frame', (frame) => this.handleIncomingFrame(frame));

        // Cleanup on tunnel close
        this.tunnelServer.on('tunnel_close', () => {
            this.closeAllConnections();
        });
    }

    handleIncomingFrame({ type, connectionId, payload }) {
        const socket = this.connections.get(connectionId);
        if (!socket) {
            if (type !== TYPES.CLOSE) {
                // Send CLOSE to remote to clean up their side
                this.tunnelServer.sendFrame(TYPES.CLOSE, connectionId);
            }
            return;
        }

        if (type === TYPES.DATA) {
            // Backpressure logic: if socket.write returns false, 
            // we could pause reading from the tunnel but for a multiplexed WS it's tricky.
            // We'll write to the socket buffer with standard Node.js mechanisms.
            // Buffer limit check to prevent OOM
            if (socket.destroyed) {
                this.tunnelServer.sendFrame(TYPES.CLOSE, connectionId);
                this.connections.delete(connectionId);
                return;
            }
            if (payload && payload.length > 0) {
                if (!socket.write(payload)) {
                    if (socket.writableLength > this.maxSocketBuffer) {
                        console.warn(`[FrameProtocol] Destroying socket ${connectionId} due to massive backpressure buffer.`);
                        this.tunnelServer.sendFrame(TYPES.CLOSE, connectionId);
                        socket.destroy();
                        this.connections.delete(connectionId);
                    }
                }
            }
        } else if (type === TYPES.CLOSE) {
            this.emit('close', connectionId); // EMIT FIRST so proxyServer catches it
            socket.destroy(); // FORCE DESTROY INSTEAD OF END TO PREVENT FD EXHAUSTION (TIME_WAIT)
            this.connections.delete(connectionId);
        } else if (type === TYPES.OPEN_ACK) {
            this.emit('open_ack', connectionId);
        }
    }

    /**
     * Register a new client connection proxying to `host:port`
     */
    registerConnection(socket, host, port) {
        if (!this.tunnelServer.isReady()) {
            socket.end('HTTP/1.1 502 Bad Gateway\r\n\r\nTunnel not connected\n');
            return null;
        }

        // Assign connectionId
        let connectionId;
        let attempts = 0;
        do {
            connectionId = this.nextConnectionId++;
            if (this.nextConnectionId > 4000000000) this.nextConnectionId = 1;
            attempts++;
            // Safety break to prevent infinite loop if somehow all 4 billion IDs are used (unlikely)
            if (attempts > 1000) {
                console.error("[FrameProtocol] CRITICAL: Could not find an available connection ID after 1000 attempts.");
                socket.end('HTTP/1.1 503 Service Unavailable\r\n\r\nServer Full');
                socket.destroy();
                return null;
            }
        } while (this.connections.has(connectionId));

        this.connections.set(connectionId, socket);

        // Initial OPEN frame payload contains the destination (host:port)
        const targetPayload = Buffer.from(`${host}:${port}`, 'utf8');
        this.tunnelServer.sendFrame(TYPES.OPEN, connectionId, targetPayload);

        // Handle local socket data
        socket.on('data', (data) => {
            this.tunnelServer.sendFrame(TYPES.DATA, connectionId, data);
        });

        // Cleanup local socket
        const cleanup = () => {
            if (this.connections.has(connectionId)) {
                this.tunnelServer.sendFrame(TYPES.CLOSE, connectionId);
                this.connections.delete(connectionId);
            }
        };

        socket.on('end', cleanup);
        socket.on('close', cleanup);
        socket.on('error', cleanup);

        return connectionId;
    }

    closeAllConnections() {
        for (const [connId, socket] of this.connections) {
            socket.destroy();
        }
        this.connections.clear();
    }
}

module.exports = FrameProtocol;
