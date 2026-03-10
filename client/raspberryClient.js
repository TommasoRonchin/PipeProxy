const fs = require('fs');
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

    const options = {};
    if (TUNNEL_SECRET) {
        if (ENABLE_SECURE_HANDSHAKE) {
            const timestamp = Date.now().toString();
            const nonce = crypto.randomBytes(16).toString('hex');
            const signature = crypto.createHmac('sha256', TUNNEL_SECRET).update(timestamp + nonce).digest('hex');

            options.headers = {
                'x-tunnel-timestamp': timestamp,
                'x-tunnel-nonce': nonce,
                'x-tunnel-signature': signature
            };
        } else {
            options.headers = {
                'x-tunnel-secret': TUNNEL_SECRET
            };
        }
    }

    const cryptoStream = new CryptoStream({
        enableEncryption: process.env.ENABLE_ENCRYPTION === 'true',
        secret: process.env.ENCRYPTION_SECRET,
        strictSequence: process.env.STRICT_SEQUENCE_CHECK !== 'false'
    });

    const ws = new WebSocket(SERVER_URL, options);
    const manager = new ConnectionManager(ws, cryptoStream);

    ws.on('open', () => {
        console.log(`[RaspberryClient] Connected to VPS Tunnel successfully.`);
    });

    ws.on('message', (data) => {
        try {
            manager.handleMessage(cryptoStream.decryptMessage(data));
        } catch (e) {
            console.error(`[RaspberryClient] Decryption failed: ${e.message}`);
        }
    });

    ws.on('close', () => {
        console.log(`[RaspberryClient] Disconnected from VPS Tunnel. Reconnecting in ${RECONNECT_DELAY_MS}ms...`);
        manager.closeAllConnections();
        setTimeout(connect, RECONNECT_DELAY_MS);
    });

    ws.on('error', (err) => {
        console.error(`[RaspberryClient] WebSocket Error: ${err.message}`);
    });
}

connect();
