const assert = require('assert');
const WebSocket = require('ws');

// Mock a fake server to send garbage data
const wss = new WebSocket.Server({ port: 8087 });

wss.on('connection', (ws) => {
    console.log("[FakeServer] Client connected. Sending valid then garbage frame to trigger Crypto Error...");

    // We send a 1-byte garbage frame. decryptMessage will fail because it's too short
    setTimeout(() => {
        ws.send(Buffer.from([0x00]));
    }, 100);
});

// We need to run client script, but it is meant to run standalone with process.exit.
// We'll mimic it by loading it manually
process.env.SERVER_URL = "ws://localhost:8087";
process.env.ENABLE_ENCRYPTION = "true";
process.env.ENCRYPTION_SECRET = "dummysecret";
process.env.RECONNECT_DELAY_MS = "500";
process.env.ENABLE_MAX_CONNECTIONS = "false"; // prevent warnings

let disconnectCount = 0;
// We'll hijack console.log and console.error to track reconnects
const originalLog = console.log;
console.log = function (...args) {
    if (args[0].includes("Disconnected from VPS Tunnel")) {
        disconnectCount++;
    }
    originalLog.apply(console, args);
}

require('./client/raspberryClient');

setTimeout(() => {
    assert.strictEqual(disconnectCount > 0, true, "Client did NOT disconnect upon receiving a corrupted payload! It swallowed it.");
    console.log("Client Crypto Security Fix Passed! The client effectively terminated the connection to realign keys upon error.");
    process.exit(0);
}, 1500);
