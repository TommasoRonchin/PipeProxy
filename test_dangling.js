const assert = require('assert');
const WebSocket = require('ws');
const TunnelServer = require('./server/tunnelServer');
const FrameProtocol = require('./server/frameProtocol');

async function testCryptoDrop() {
    console.log("--- Testing Dangling Connection Fix ---");
    const tunnelServer = new TunnelServer({ port: 8086, secret: "test_secret" });
    const protocol = new FrameProtocol(tunnelServer);
    await tunnelServer.start();

    // Disabilita il rate limit (anti-flapping) per permettere il reconnect istantaneo nel test
    process.env.RATE_LIMIT_MS = '0';

    // Mock proxy connection registering
    // We register two dummy sockets as proxy client connections
    const dummySocket1 = { destroy: () => { dummySocket1.destroyed = true; } };
    const dummySocket2 = { destroy: () => { dummySocket2.destroyed = true; } };
    protocol.connections.set(1001, dummySocket1);
    protocol.connections.set(1002, dummySocket2);

    console.log("Registered 2 dummy proxy connections on FrameProtocol...");
    assert.strictEqual(protocol.connections.size, 2);

    const ws = new WebSocket('ws://localhost:8086', {
        headers: {
            'x-tunnel-secret': 'test_secret'
        }
    });

    let disconnected = false;
    ws.on('close', () => { disconnected = true; });

    await new Promise(r => ws.on('open', r));

    console.log("Reconnecting quickly to simulate flapping / dangling connection edge-case...");
    const ws2 = new WebSocket('ws://localhost:8086', {
        headers: { 'x-tunnel-secret': 'test_secret' }
    });

    await new Promise(r => ws2.on('open', r));

    // Wait a tick for server to process the drop
    await new Promise(r => setTimeout(r, 500));

    // The first socket should have been forcefully dropped by the server
    assert.strictEqual(disconnected, true, "First socket was not disconnected upon reconnection");

    // Test that the tunnel_close event fired correctly and cleaned the connections map
    assert.strictEqual(protocol.connections.size, 0, "Dangling proxy connections were not cleaned up!");
    assert.strictEqual(dummySocket1.destroyed, true, "Socket 1 wasn't destroyed");
    assert.strictEqual(dummySocket2.destroyed, true, "Socket 2 wasn't destroyed");

    tunnelServer.stop();
    console.log("Memory Leak Test Passed! Dangling connections are correctly garbage collected.");
}

testCryptoDrop().catch(e => {
    console.error(e);
    process.exit(1);
});
