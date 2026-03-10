const { TYPES } = require('../shared/frameEncoder');

class FrameProtocol {
    constructor(tunnelServer) {
        this.tunnelServer = tunnelServer;
        // Map of connectionId -> socket
        this.connections = new Map();
        this.nextConnectionId = 1;

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
            if (payload && payload.length > 0) {
                socket.write(payload);
            }
        } else if (type === TYPES.CLOSE) {
            socket.end();
            this.connections.delete(connectionId);
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
        const connectionId = this.nextConnectionId++;
        // Maximum 32-bit uint
        if (this.nextConnectionId > 4000000000) this.nextConnectionId = 1;

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
