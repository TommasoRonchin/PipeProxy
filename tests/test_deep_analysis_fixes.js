const assert = require('assert');
const { EventEmitter } = require('events');

// --- Mocks ---
class MockSocket extends EventEmitter {
    constructor() {
        super();
        this.destroyed = false;
        this.writableLength = 0;
    }
    write(data) { return true; }
    destroy() { this.destroyed = true; this.emit('close'); }
    end() { this.destroyed = true; this.emit('end'); this.emit('close'); }
}

class MockTunnelServer extends EventEmitter {
    constructor() {
        super();
        this.sentFrames = [];
    }
    isReady() { return true; }
    sendFrame(type, connId, payload) {
        this.sentFrames.push({ type, connId, payload });
        return true;
    }
}

// --- Imports ---
const FrameProtocol = require('./server/frameProtocol');
const { TYPES, encodeFrame } = require('./shared/frameEncoder');
const { CryptoStream } = require('./shared/cryptoStream');

async function runTests() {
    console.log("🚀 Starting Deep Verification Tests for Recent Fixes...\n");

    let testsPassed = 0;
    let testsFailed = 0;

    function runTest(name, fn) {
        process.stdout.write(`--- Test: ${name} --- `);
        try {
            fn();
            console.log("✅ PASS");
            testsPassed++;
        } catch (e) {
            console.log("❌ FAIL");
            console.error(e);
            testsFailed++;
        }
    }

    // --- TEST 1: HTTP Pipelining Credential Leak (FrameProtocol) ---
    runTest("HTTP Pipelining Credential Redaction", () => {
        const tunnelServer = new MockTunnelServer();
        const protocol = new FrameProtocol(tunnelServer);

        const socket = new MockSocket();
        socket.isHttpProxy = true; // Simulating plain HTTP Proxy

        const connId = protocol.registerConnection(socket, "example.com", 80);

        // Simulate incoming pipelined chunk containing Proxy-Authorization
        const maliciousPayload = Buffer.from(
            "GET http://example.com/page2 HTTP/1.1\r\n" +
            "Host: example.com\r\n" +
            "Proxy-Authorization: Basic YWRtaW46cGFzc3dvcmQ=\r\n" +
            "Connection: keep-alive\r\n\r\n"
        );

        socket.emit('data', maliciousPayload);

        // Verify sent frame
        const dataFrame = tunnelServer.sentFrames.find(f => f.type === TYPES.DATA);
        assert(dataFrame, "Data frame should have been sent");

        const sentString = dataFrame.payload.toString('utf8');
        assert(!sentString.includes('Proxy-Authorization: Basic'), "Proxy-Authorization MUST be stripped from downstream");
        assert(sentString.includes('GET http://example.com'), "Request line must still be present");
    });

    // --- TEST 2: FD Exhaustion Fix (Socket.destroy on CLOSE) ---
    runTest("FD Exhaustion (Socket.destroy on TUNNEL CLOSE)", () => {
        const tunnelServer = new MockTunnelServer();
        const protocol = new FrameProtocol(tunnelServer);

        const socket = new MockSocket();
        const connId = protocol.registerConnection(socket, "example.com", 80);

        // Simulate receiving a CLOSE frame from the tunnel
        protocol.handleIncomingFrame({ type: TYPES.CLOSE, connectionId: connId });

        assert(socket.destroyed, "Socket MUST be destroyed immediately to prevent TIME_WAIT FD Exhaustion");
        assert(!protocol.connections.has(connId), "Connection must be removed from map");
    });

    // --- TEST 3: CryptoStream Replay Attack Uint32 Wrap-around ---
    runTest("CryptoStream Sequence Wrap-Around (> 4.2 Billion)", () => {
        const stream = new CryptoStream({ enableEncryption: true, secret: 'test-secret', strictSequence: false });

        // Fast-forward sequence counters to near 32-bit limit
        stream.outSeq = 4294967290; // 4.29 Billion (UInt32 Max is 4,294,967,295)
        stream.expectedInSeq = 4294967290;

        // Send 10 messages to force a wrap-around
        let lastDecrypted = null;
        for (let i = 0; i < 10; i++) {
            const payload = Buffer.from(`Data ${i}`);
            const encrypted = stream.encryptMessage(payload);

            // Decrypt it
            lastDecrypted = stream.decryptMessage(encrypted);
            assert.strictEqual(lastDecrypted.toString(), `Data ${i}`, "Decrypted data must match");
        }

        // Verify that expectedInSeq wrapped correctly and didn't stall
        assert(stream.expectedInSeq < 10, `expectedInSeq should have wrapped to a small number, found: ${stream.expectedInSeq}`);
    });

    // --- TEST 4: Max Frame Size Buffer Limiter ---
    runTest("OOM Protection (50MB Encode Limiter)", () => {
        let errorCaught = false;
        try {
            // Attempt to encode 60MB frame
            const evilPayload = Buffer.alloc(60 * 1024 * 1024);
            encodeFrame(TYPES.DATA, 1, evilPayload);
        } catch (e) {
            errorCaught = true;
            assert(e.message.includes("50MB limit"), "Must throw 50MB limit error");
        }
        assert(errorCaught, "Encoder MUST reject massive payloads to prevent OOM");
    });

    console.log(`\nResults: ${testsPassed} passed, ${testsFailed} failed.`);
    if (testsFailed > 0) process.exit(1);
}

runTests();
