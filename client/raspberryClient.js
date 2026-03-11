const fs = require('fs');

process.on('uncaughtException', (err) => {
    console.error(`[RaspberryClient] Uncaught Exception: ${err.message}`, err);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error(`[RaspberryClient] Unhandled Rejection:`, reason);
});

if (process.env.SKIP_DOTENV !== 'true') {
    if (fs.existsSync('.env')) {
        require('dotenv').config({ path: '.env' });
    } else {
        require('dotenv').config({ path: '.env.client' });
    }
}
const WebSocket = require('ws');
const crypto = require('crypto');
const ConnectionManager = require('./connectionManager');
const { CryptoStream } = require('../shared/cryptoStream');

const SERVER_URL = process.env.SERVER_URL || 'ws://localhost:8080';
const TUNNEL_SECRET = process.env.TUNNEL_SECRET;
const ENABLE_SECURE_HANDSHAKE = process.env.ENABLE_SECURE_HANDSHAKE === 'true';
const RECONNECT_DELAY_MS = process.env.RECONNECT_DELAY_MS ? parseInt(process.env.RECONNECT_DELAY_MS, 10) : 3000;

function connect() {
    console.log(`[RaspberryClient] Connecting to VPS tunnel at ${SERVER_URL}...`);

    const options = { headers: {} };
    const sessionNonce = crypto.randomBytes(16).toString('hex');
    options.headers['x-tunnel-session-nonce'] = sessionNonce;

    if (TUNNEL_SECRET) {
        if (ENABLE_SECURE_HANDSHAKE) {
            const timestamp = Date.now().toString();
            const nonce = crypto.randomBytes(16).toString('hex');
            const signature = crypto.createHmac('sha256', TUNNEL_SECRET).update(timestamp + nonce).digest('hex');

            options.headers['x-tunnel-timestamp'] = timestamp;
            options.headers['x-tunnel-nonce'] = nonce;
            options.headers['x-tunnel-signature'] = signature;
        } else {
            options.headers['x-tunnel-secret'] = TUNNEL_SECRET;
        }
    }

    const cryptoStream = new CryptoStream({
        enableEncryption: process.env.ENABLE_ENCRYPTION === 'true',
        secret: process.env.ENCRYPTION_SECRET,
        sessionNonce: sessionNonce,
        strictSequence: process.env.STRICT_SEQUENCE_CHECK !== 'false'
    });

    const ws = new WebSocket(SERVER_URL, options);
    const manager = new ConnectionManager(ws, cryptoStream);

    let pingTimeout;

    function heartbeat() {
        clearTimeout(pingTimeout);
        // Timeout relies on server PING_INTERVAL_MS. Default is 30s, we add a 5s grace period.
        const timeoutMs = process.env.PING_INTERVAL_MS ? parseInt(process.env.PING_INTERVAL_MS, 10) + 5000 : 35000;
        pingTimeout = setTimeout(() => {
            console.warn(`[RaspberryClient] No ping received from server in ${timeoutMs}ms. Connection might be dead. Terminating...`);
            ws.terminate();
        }, timeoutMs);
    }

    ws.on('open', () => {
        console.log(`[RaspberryClient] Connected to VPS Tunnel successfully.`);
        heartbeat();
    });

    ws.on('ping', () => {
        heartbeat();
    });

    ws.on('message', (data) => {
        try {
            manager.handleMessage(cryptoStream.decryptMessage(data));
        } catch (e) {
            console.error(`[RaspberryClient] Decryption failed: ${e.message}`);
            // Critical security fix: if decryption fails (e.g. sequence number mismatch 
            // after a connection flap or tampering), we MUST drop the connection to force
            // a fresh handshake and reset the expected payload sequences. Otherwise, we
            // swallow exceptions forever and the tunnel gets "frozen" but kept alive by ping.
            ws.terminate();
        }
    });

    ws.on('close', () => {
        clearTimeout(pingTimeout);
        console.log(`[RaspberryClient] Disconnected from VPS Tunnel. Reconnecting in ${RECONNECT_DELAY_MS}ms...`);
        manager.closeAllConnections();
        setTimeout(connect, RECONNECT_DELAY_MS);
    });

    ws.on('error', (err) => {
        console.error(`[RaspberryClient] WebSocket Error: ${err.message}`);
    });
}

connect();
