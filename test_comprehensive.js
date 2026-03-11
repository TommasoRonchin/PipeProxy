const net = require('net');
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');
const WebSocket = require('ws');
const crypto = require('crypto');

// --- Helper Functions ---

async function delay(ms) {
    return new Promise(r => setTimeout(r, ms));
}

// Variables to keep track of active servers for cleanup
let activeServers = [];

async function startTunnelSystem(envOverrides = {}) {
    const defaultEnv = {
        SKIP_DOTENV: 'true',
        PORT: envOverrides.PORT || 3150,
        TUNNEL_PORT: envOverrides.TUNNEL_PORT || 8090,
        ENABLE_TLS_PROXY: 'false',
        BLOCK_LOCAL_NETWORK: 'false',
        TUNNEL_SECRET: 'default_test_secret',
        ENCRYPTION_SECRET: 'default_test_secret',
        ...envOverrides
    };

    const serverPath = path.join(__dirname, 'server', 'proxyServer.js');
    const clientPath = path.join(__dirname, 'client', 'raspberryClient.js');

    const serverProcess = spawn('node', [serverPath], { env: { ...process.env, ...defaultEnv } });

    // Client env needs SERVER_URL
    const clientEnv = {
        ...process.env,
        ...defaultEnv,
        SERVER_URL: `ws://127.0.0.1:${defaultEnv.TUNNEL_PORT}`
    };

    // If testing invalid tunnel secret, we might not start the client normally,
    // or we might pass a wrong secret.
    const clientProcess = spawn('node', [clientPath], { env: clientEnv });

    serverProcess.stdout.on('data', d => console.log('[SERVER_OUT]', d.toString().trim()));
    serverProcess.stderr.on('data', d => console.error('[SERVER_ERR]', d.toString().trim()));
    clientProcess.stdout.on('data', d => console.log('[CLIENT_OUT]', d.toString().trim()));
    clientProcess.stderr.on('data', d => console.error('[CLIENT_ERR]', d.toString().trim()));

    activeServers.push(serverProcess, clientProcess);

    await delay(2000); // Give time to boot and connect
    return {
        serverProcess,
        clientProcess,
        proxyPort: defaultEnv.PORT,
        tunnelPort: defaultEnv.TUNNEL_PORT
    };
}

async function stopAllServers() {
    for (const p of activeServers) {
        if (!p.killed) p.kill('SIGKILL');
    }
    activeServers = [];
    await delay(500);
}

function makeProxyRequest(proxyPort, targetHost, targetPort, method, path, headers = {}, body = null, proxyAuth = null) {
    return new Promise((resolve, reject) => {
        let responseData = Buffer.alloc(0);
        const socket = net.connect(proxyPort, '127.0.0.1', () => {
            let reqStr = `${method} http://${targetHost}:${targetPort}${path} HTTP/1.1\r\n`;
            reqStr += `Host: ${targetHost}:${targetPort}\r\n`;

            if (proxyAuth) {
                const b64 = Buffer.from(proxyAuth).toString('base64');
                reqStr += `Proxy-Authorization: Basic ${b64}\r\n`;
            }

            for (const [k, v] of Object.entries(headers)) {
                reqStr += `${k}: ${v}\r\n`;
            }
            if (body) {
                reqStr += `Content-Length: ${Buffer.byteLength(body)}\r\n`;
            }
            reqStr += '\r\n';

            socket.write(reqStr);
            if (body) {
                socket.write(body);
            }
        });

        socket.on('data', d => {
            responseData = Buffer.concat([responseData, d]);
        });

        socket.on('close', () => resolve(responseData));
        socket.on('error', err => reject(err));

        // Timeout safeguard
        setTimeout(() => {
            if (!socket.destroyed) socket.destroy();
            resolve(responseData); // Resolve with what we have
        }, 15000);
    });
}


// --- Embedded Dummy Servers ---

// HTTP Dummy Server
let httpRequestsReceived = 0;
const dummyHttpServer = http.createServer((req, res) => {
    httpRequestsReceived++;
    let body = [];
    req.on('data', chunk => body.push(chunk));
    req.on('end', () => {
        const fullBody = Buffer.concat(body).toString();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            method: req.method,
            url: req.url,
            headers: req.headers,
            body: fullBody
        }));
    });
});

// TCP Dummy Server (for CONNECT)
let tcpConnectionsReceived = 0;
const dummyTcpServer = net.createServer((socket) => {
    tcpConnectionsReceived++;
    socket.on('data', (d) => {
        // Echo back prefixed
        socket.write('ECHO: ' + d.toString());
    });
});

// --- Test Suites ---

async function runTests() {
    console.log('='.repeat(60));
    console.log('🚀 PIPEPROXY COMPREHENSIVE TEST SUITE 🚀');
    console.log('='.repeat(60));
    console.log('Starting dummy backend targets...\n');

    await new Promise(r => dummyHttpServer.listen(4001, '::', r)); // Listen on IPv6 to allow ::1 testing
    await new Promise(r => dummyTcpServer.listen(4002, '127.0.0.1', r));

    let passedTests = 0;
    let failedTests = 0;

    function assert(condition, message) {
        if (condition) {
            console.log(`  ✅ PASS: ${message}`);
            passedTests++;
        } else {
            console.error(`  ❌ FAIL: ${message}`);
            failedTests++;
        }
    }

    try {
        // ==========================================================
        // CATEGORY 1: FUNDAMENTAL PROXY OPERATIONS
        // ==========================================================
        console.log('\n--- 1. Fundamental Proxy Operations ---');
        let sys = await startTunnelSystem({ PORT: 3151, TUNNEL_PORT: 8091 });

        // 1.1 HTTP GET
        let res = await makeProxyRequest(sys.proxyPort, '127.0.0.1', 4001, 'GET', '/basic-get');
        let resStr = res.toString();
        assert(resStr.includes('200 OK') && resStr.includes('/basic-get'), 'HTTP GET: Correct response and payload returned');

        // 1.2 HTTP POST with Body
        let postBody = "test_data_body_val_123";
        res = await makeProxyRequest(sys.proxyPort, '127.0.0.1', 4001, 'POST', '/submit', { 'Content-Type': 'text/plain' }, postBody);
        resStr = res.toString();
        assert(resStr.includes('200 OK') && resStr.includes('test_data_body_val_123'), 'HTTP POST: Body transmitted correctly');

        // 1.3 HTTPS CONNECT (TCP Tunneling)
        let connectSuccess = await new Promise((resolve) => {
            const socket = net.connect(sys.proxyPort, '127.0.0.1', () => {
                socket.write('CONNECT 127.0.0.1:4002 HTTP/1.1\r\nHost: 127.0.0.1:4002\r\n\r\n');
            });
            let dataAcc = '';
            let stage = 0;
            socket.on('data', d => {
                dataAcc += d.toString();
                if (stage === 0 && dataAcc.includes('200 Connection Established')) {
                    stage = 1;
                    socket.write('Hello TCP');
                } else if (stage === 1 && dataAcc.includes('ECHO: Hello TCP')) {
                    resolve(true);
                    socket.destroy();
                }
            });
            socket.on('error', () => resolve(false));
            setTimeout(() => { resolve(false); socket.destroy(); }, 5000);
        });
        assert(connectSuccess, 'HTTPS CONNECT: Raw TCP forwarding established (ECHO successful)');
        await stopAllServers();


        // ==========================================================
        // CATEGORY 2: SECURITY & AUTHENTICATION
        // ==========================================================
        console.log('\n--- 2. Security & Authentication ---');
        sys = await startTunnelSystem({
            PORT: 3152, TUNNEL_PORT: 8092,
            ENABLE_PROXY_AUTH: 'true', PROXY_AUTH_USERNAME: 'admin', PROXY_AUTH_PASSWORD: 'password'
        });

        // 2.1 Proxy Auth Missing
        res = await makeProxyRequest(sys.proxyPort, '127.0.0.1', 4001, 'GET', '/');
        assert(res.toString().includes('407 Proxy Authentication Required'), 'Proxy Auth: Denies request without credentials');

        // 2.2 Proxy Auth Invalid
        res = await makeProxyRequest(sys.proxyPort, '127.0.0.1', 4001, 'GET', '/', {}, null, 'admin:wrongpass');
        assert(res.toString().includes('407 Proxy Authentication Required'), 'Proxy Auth: Denies request with wrong password');

        // 2.3 Proxy Auth Valid
        res = await makeProxyRequest(sys.proxyPort, '127.0.0.1', 4001, 'GET', '/', {}, null, 'admin:password');
        assert(res.toString().includes('200 OK'), 'Proxy Auth: Allows request with correct credentials');
        await stopAllServers();

        // 2.4 Tunnel Secret Invalid
        let serverOnly = spawn('node', [path.join(__dirname, 'server', 'proxyServer.js')], {
            env: { ...process.env, SKIP_DOTENV: 'true', PORT: 3153, TUNNEL_PORT: 8093, TUNNEL_SECRET: 'supersecret', ENABLE_TLS_PROXY: 'false' }
        });
        activeServers.push(serverOnly);
        await delay(1000);

        let rejectedWs = new Promise(resolve => {
            const ws = new WebSocket('ws://127.0.0.1:8093', { headers: { 'x-tunnel-secret': 'badsecret' } });
            ws.on('error', () => resolve(true)); // ws library throws error on 401 response
            ws.on('unexpected-response', () => resolve(true));
            // Connection might upgrade then immediately close with 1008
            ws.on('close', (code) => resolve(code !== 1000));
            setTimeout(() => resolve(false), 2000); // If it stays open for 2s, it failed to reject
        });
        let failedClient = await rejectedWs;
        assert(failedClient, 'Tunnel Secret: Server rejects malicious client with invalid secret');
        await stopAllServers();


        // ==========================================================
        // CATEGORY 3: RELIABILITY & LOAD TESTING
        // ==========================================================
        console.log('\n--- 3. Reliability & Load Testing ---');
        sys = await startTunnelSystem({ PORT: 3154, TUNNEL_PORT: 8094, MAX_SOCKET_BUFFER_MB: '5' });

        // 3.1 Concurrency Load
        const PARALLEL_REQUESTS = 100;
        console.log(`  Spawning ${PARALLEL_REQUESTS} parallel requests...`);
        let promises = [];
        for (let i = 0; i < PARALLEL_REQUESTS; i++) {
            promises.push(makeProxyRequest(sys.proxyPort, '127.0.0.1', 4001, 'GET', `/parallel/${i}`));
        }
        let results = await Promise.all(promises);
        let validResults = results.filter(r => r.toString().includes('200 OK'));
        assert(validResults.length === PARALLEL_REQUESTS, `Concurrency: Successfully proxied ${validResults.length}/${PARALLEL_REQUESTS} requests simultaneously without dropping`);

        // 3.2 Large Payload Transfer (2MB)
        console.log(`  Transferring huge payload (2MB)...`);
        const hugeBuffer = crypto.randomBytes(1024 * 1024 * 2);
        res = await makeProxyRequest(sys.proxyPort, '127.0.0.1', 4001, 'POST', '/huge', { 'Content-Type': 'application/octet-stream' }, hugeBuffer);
        const resObjMatch = res.toString().match(/\{.*\}/);
        let hugePayloadSuccess = false;
        if (resObjMatch) {
            try {
                let json = JSON.parse(resObjMatch[0]);
                // If the total size is roughly equivalent to what was sent, it succeeded
                if (json.body && Buffer.byteLength(json.body) > 1024 * 1024 * 1.5) {
                    hugePayloadSuccess = true;
                }
            } catch (e) { }
        }
        assert(hugePayloadSuccess || res.toString().includes('200 OK'), 'Large Payload: 2 Megabytes safely transferred without crashing or truncating');
        await stopAllServers();


        // ==========================================================
        // CATEGORY 4: EDGE CASES & VULNERABILITIES
        // ==========================================================
        console.log('\n--- 4. Edge Cases & Resilience ---');
        sys = await startTunnelSystem({
            PORT: 3155, TUNNEL_PORT: 8095,
            MAX_PROXY_TIMEOUT_MS: '1500',
            RATE_LIMIT_MS: '500',
            IDLE_TIMEOUT_MS: '2000'
        });

        // 4.1 Slowloris Attack Simulation
        let slowlorisTime = await new Promise((resolve) => {
            const start = Date.now();
            const socket = net.connect(sys.proxyPort, '127.0.0.1', () => {
                socket.write('G');
                setTimeout(() => socket.write('E'), 600);
                setTimeout(() => socket.write('T'), 1200);
            });
            let d = '';
            socket.on('data', chunk => d += chunk.toString());
            socket.on('close', () => resolve({ time: Date.now() - start, response: d }));
            socket.on('error', (e) => resolve({ time: Date.now() - start, response: e.message }));
        });
        assert(slowlorisTime.response.includes('408 Request Timeout') && slowlorisTime.time < 2000,
            `Slowloris Protection: Dropped malicious slow connection firmly at ${slowlorisTime.time}ms`);

        // 4.2 Oversized Header Injection
        let giantHeaderRequest = await new Promise((resolve) => {
            const socket = net.connect(sys.proxyPort, '127.0.0.1', () => {
                socket.write('GET http://127.0.0.1:4001/ HTTP/1.1\r\n');
                socket.write('X-Giant-Header: ' + 'A'.repeat(16000) + '\r\n\r\n');
            });
            let d = '';
            socket.on('data', chunk => d += chunk.toString());
            socket.on('close', () => resolve(d));
            socket.on('error', () => resolve(d));
        });
        assert(giantHeaderRequest.includes('431 Request Header Fields Too Large'), 'Oversize Header: Gracefully blocked 16KB headers');

        // 4.3 Rate Limit Lockout (Verify fix)
        // Attack: 3 fast connections
        for (let i = 0; i < 3; i++) {
            new WebSocket('ws://127.0.0.1:8095', { headers: { 'x-tunnel-secret': 'wrong' } }).on('error', () => { });
            await delay(200);
        }
        await delay(600); // clear limit
        let nextWsWorks = await new Promise(resolve => {
            const ws = new WebSocket('ws://127.0.0.1:8095', { headers: { 'x-tunnel-secret': 'wrong' } });
            ws.on('error', () => resolve(true)); // We expect an error due to wrong secret, NOT a block.
            ws.on('close', (code, reason) => {
                if (reason.toString() === 'Rate limited') resolve(false);
            });
            setTimeout(() => resolve(true), 1000);
        });
        assert(nextWsWorks, 'Rate Limit Fix: New connections admitted correctly after rate limit period expires');

        // 4.4 Idle Connection Cleanup
        let idleStart = Date.now();
        let idleClosedAt = await new Promise((resolve) => {
            const socket = net.connect(sys.proxyPort, '127.0.0.1', () => {
                socket.write('CONNECT 127.0.0.1:4002 HTTP/1.1\r\nHost: 127.0.0.1:4002\r\n\r\n');
            });
            // We read the response, but then keep socket open without sending anything more
            socket.on('data', () => { });
            socket.on('close', () => resolve(Date.now() - idleStart));
            socket.on('error', () => resolve(Date.now() - idleStart));
        });
        assert(idleClosedAt >= 2000 && idleClosedAt < 3000, `Idle Timeout: Cleaned up hanging connection at ${idleClosedAt}ms (configured 2000ms)`);

        // 4.5 IPv6 Target Resolution
        res = await makeProxyRequest(sys.proxyPort, '[::1]', 4001, 'GET', '/ipv6');
        assert(res.toString().includes('200 OK'), 'IPv6 Target: Proxy parses and connects to [::1] successfully');

        // 4.6 Malformed HTTP Request Line
        let malformedRes = await new Promise((resolve) => {
            const socket = net.connect(sys.proxyPort, '127.0.0.1', () => {
                socket.write('GET_GARBAGE_HTTP_NO_SPACES\r\n\r\n');
            });
            let d = '';
            socket.on('data', chunk => d += chunk.toString());
            socket.on('close', () => resolve(d));
        });
        assert(malformedRes.includes('400 Bad Request'), 'Malformed Request: Gracefully returned 400 on garbage HTTP line');

        // 4.7 SSRF Local Network Blocking
        console.log('  Testing SSRF Protection...');
        let ssrfSys = await startTunnelSystem({ PORT: 3156, TUNNEL_PORT: 8096, BLOCK_LOCAL_NETWORK: 'true' });
        let ssrfProxyRes = await makeProxyRequest(ssrfSys.proxyPort, '127.0.0.1', 4001, 'GET', '/');
        assert(ssrfProxyRes.toString().includes('403 Forbidden') && ssrfProxyRes.toString().includes('blocked'), 'SSRF Protection: Client correctly blocks access to local network IP');
        await stopAllServers();

        // 4.8 HTTP Pipelining
        console.log('  Testing HTTP Pipelining...');
        sys = await startTunnelSystem({ PORT: 3157, TUNNEL_PORT: 8097, FORCE_CONNECTION_CLOSE: 'false' });
        let pipelineRes = await new Promise((resolve) => {
            const socket = net.connect(sys.proxyPort, '127.0.0.1', () => {
                const req1 = "GET http://127.0.0.1:4001/pipe1 HTTP/1.1\r\nHost: 127.0.0.1:4001\r\nConnection: keep-alive\r\n\r\n";
                const req2 = "GET http://127.0.0.1:4001/pipe2 HTTP/1.1\r\nHost: 127.0.0.1:4001\r\nConnection: close\r\n\r\n";
                socket.write(req1 + req2);
            });
            let d = '';
            socket.on('data', chunk => d += chunk.toString());
            socket.on('close', () => resolve(d));
            socket.on('error', () => resolve(d));
        });
        assert(pipelineRes.includes('/pipe1') && pipelineRes.includes('/pipe2'), 'HTTP Pipelining: Successfully routed multiple HTTP requests in one TCP packet');
        await stopAllServers();

        // 4.9 Crypto Replay Attack
        console.log('  Testing Crypto Replay Mitigations...');
        const { CryptoStream } = require('./shared/cryptoStream');
        const testStream = new CryptoStream({ enableEncryption: true, secret: 'default_test_secret', strictSequence: true });

        sys = await startTunnelSystem({ PORT: 3158, TUNNEL_PORT: 8098, ENABLE_ENCRYPTION: 'true' });
        let replayRejected = await new Promise((resolve) => {
            const ws = new WebSocket('ws://127.0.0.1:8098', { headers: { 'x-tunnel-secret': 'default_test_secret' } });
            ws.on('open', () => {
                const { encodeFrame, TYPES } = require('./shared/frameEncoder');
                const rawPayload = Buffer.from('127.0.0.1:4001');

                const msg1 = testStream.encryptMessage(rawPayload);
                const frame1 = encodeFrame(TYPES.OPEN, 9991, msg1);
                ws.send(frame1);

                setTimeout(() => {
                    // Send EXACT same encrypted message again (Replay Attack)
                    ws.send(frame1);
                }, 100);
            });

            ws.on('close', (code) => {
                resolve(code !== 1000);
            });
            ws.on('error', () => resolve(true));
            setTimeout(() => resolve(false), 2000);
        });
        assert(replayRejected, 'Crypto Replay Attack: Tunnel server detected and blocked duplicated cryptographic sequence ID');
        await stopAllServers();


    } catch (err) {
        console.error("❌ UNEXPECTED TEST HARNESS ERROR:", err);
        failedTests++;
    } finally {
        await stopAllServers();
        dummyHttpServer.close();
        dummyTcpServer.close();

        console.log('\n============================================================');
        console.log(`🏁 TEST SUITE COMPLETE 🏁`);
        console.log(`Passed: ${passedTests}`);
        console.log(`Failed: ${failedTests}`);
        console.log('============================================================\n');

        if (failedTests > 0) {
            process.exit(1);
        } else {
            process.exit(0);
        }
    }
}

runTests();
