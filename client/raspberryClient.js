const fs = require('fs');
if (fs.existsSync('.env')) {
    require('dotenv').config({ path: '.env' });
} else {
    require('dotenv').config({ path: '.env.client' });
}
const WebSocket = require('ws');
const ConnectionManager = require('./connectionManager');
const { decryptMessage } = require('../shared/cryptoStream');

const SERVER_URL = process.env.SERVER_URL || 'ws://localhost:8080';
const TUNNEL_SECRET = process.env.TUNNEL_SECRET;

function connect() {
    console.log(`[RaspberryClient] Connecting to VPS tunnel at ${SERVER_URL}...`);

    const options = {};
    if (TUNNEL_SECRET) {
        options.headers = {
            'x-tunnel-secret': TUNNEL_SECRET
        };
    }

    const ws = new WebSocket(SERVER_URL, options);
    const manager = new ConnectionManager(ws);

    ws.on('open', () => {
        console.log(`[RaspberryClient] Connected to VPS Tunnel successfully.`);
    });

    ws.on('message', (data) => {
        try {
            manager.handleMessage(decryptMessage(data));
        } catch (e) {
            console.error(`[RaspberryClient] Decryption failed: ${e.message}`);
        }
    });

    ws.on('close', () => {
        console.log(`[RaspberryClient] Disconnected from VPS Tunnel. Reconnecting in 3s...`);
        manager.closeAllConnections();
        setTimeout(connect, 3000);
    });

    ws.on('error', (err) => {
        console.error(`[RaspberryClient] WebSocket Error: ${err.message}`);
    });
}

connect();
