const TunnelServer = require('./server/tunnelServer');
const WebSocket = require('ws');

async function testFixes() {
    console.log("Starting TunnelServer Vulnerability Fixes Test...");
    let passed = 0;

    // Test 1: Instantiation with taken port (Unhandled Exception Fix)
    const net = require('net');
    const dummyServer = net.createServer().listen(8081);
    const ts1 = new TunnelServer({ port: 8081 });
    try {
        await ts1.start();
        console.error("❌ Test 1 Failed: Server started on occupied port.");
    } catch (e) {
        if (e.code === 'EADDRINUSE') {
            console.log("✅ Test 1 Passed: Server rejected start correctly (Did not crash).", e.code);
            passed++;
        } else {
            console.error("❌ Test 1 Failed with unexpected error: ", e);
        }
    }
    dummyServer.close();

    // Test 2: Crypto Stream Isolation
    process.env.RATE_LIMIT_MS = '0';
    const ts2 = new TunnelServer({ port: 8082, secret: 'test' });
    await ts2.start();

    const assignedStreams = [];
    ts2.wss.on('connection', (ws) => {
        // give it a brief moment to assign ws.cryptoStream
        setTimeout(() => {
            assignedStreams.push(ws.cryptoStream);
        }, 10);
    });

    // Mock clients
    const client1 = new WebSocket('ws://localhost:8082', { headers: { 'x-tunnel-secret': 'test' } });
    await new Promise(r => client1.once('open', r));

    const client2 = new WebSocket('ws://localhost:8082', { headers: { 'x-tunnel-secret': 'test' } });
    await new Promise(r => client2.once('open', r));

    // Give the server time to process the connections
    await new Promise(r => setTimeout(r, 100));

    // Check if both had independent streams.
    if (assignedStreams.length >= 2 && assignedStreams[0] !== assignedStreams[1] && assignedStreams[0] !== undefined) {
        console.log("✅ Test 2 Passed: Crypto Streams are isolated per socket.");
        passed++;
    } else {
        console.error("❌ Test 2 Failed: Crypto Streams not fully isolated or missing.", assignedStreams.length);
    }

    // Test 3: Unhandled send exception
    ts2.activeWs.send = () => { throw new Error('Mock send failure'); };
    const sendResult = ts2.sendFrame('DATA', 1, Buffer.from('test'));
    if (sendResult === false) {
        console.log("✅ Test 3 Passed: Unhandled send exception was gracefully caught.");
        passed++;
    } else {
        console.error("❌ Test 3 Failed: sendFrame did not catch the error or returned true.");
    }

    // Test 4: Stop leak fix
    ts2.stop();
    if (ts2.wss === null && ts2.activeWs === null) {
        console.log("✅ Test 4 Passed: Server stopped cleanly without hanging sockets.");
        passed++;
    } else {
        console.error("❌ Test 4 Failed: Server did not clean up completely.");
    }

    client1.terminate();
    client2.terminate();

    console.log(`\nTests completed: ${passed}/4 passed.`);
    process.exit(passed === 4 ? 0 : 1);
}

testFixes().catch(e => {
    console.error(e);
    process.exit(1);
});
