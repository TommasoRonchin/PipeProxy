const net = require('net');
const WebSocket = require('ws');
const crypto = require('crypto');
const http = require('http');

// Load environment to match server configuration
require('dotenv').config({ path: '.env.server.example' });
process.env.TUNNEL_SECRET = 'test_secret';
process.env.ENABLE_SECURE_HANDSHAKE = 'true';
process.env.ENABLE_PROXY_AUTH = 'false'; // disable proxy auth for testing Keep-Alive routing

const TUNNEL_PORT = 8080;
const PROXY_PORT = 3128;
const TUNNEL_SECRET = 'test_secret';

// We run the actual server in background
const { spawn } = require('child_process');
const path = require('path');

async function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

let serverProcess;

async function setupServer() {
    console.log("Starting proxy server...");
    serverProcess = spawn('node', [path.join(__dirname, 'server', 'proxyServer.js')], {
        env: { ...process.env, PORT: PROXY_PORT, TUNNEL_PORT: TUNNEL_PORT },
        stdio: 'pipe'
    });

    serverProcess.stdout.on('data', data => console.log(`[Server] ${data.toString().trim()}`));
    serverProcess.stderr.on('data', data => console.error(`[Server Error] ${data.toString().trim()}`));

    await sleep(2000); // give server time to start
}

async function testNaNTimestamp() {
    console.log("\n--- Testing NaN Timestamp Validation ---");
    return new Promise((resolve, reject) => {
        const timestamp = "invalid_not_a_number";
        const nonce = crypto.randomBytes(16).toString('hex');
        const signature = crypto.createHmac('sha256', TUNNEL_SECRET).update(timestamp + nonce).digest('hex');

        const ws = new WebSocket(`ws://localhost:${TUNNEL_PORT}`, {
            headers: {
                'x-tunnel-timestamp': timestamp,
                'x-tunnel-nonce': nonce,
                'x-tunnel-signature': signature
            }
        });

        // We expect the server to close the connection immediately after connection upgrade
        let closedCorrectly = false;

        ws.on('unexpected-response', (request, response) => {
            if (response.statusCode === 401 || response.statusCode === 403 || parseInt(response.headers['x-websocket-reject-code'] || 0) === 1008) {
                console.log(`✅ PASS: Connection rejected via HTTP (${response.statusCode})`);
                closedCorrectly = true;
                resolve(true);
            } else {
                console.error(`❌ FAIL: Unexpected response code: ${response.statusCode}`);
                resolve(false);
            }
        });

        ws.on('error', (err) => {
            // connection drops are expected
        });

        ws.on('close', (code, reason) => {
            if (code === 1008) {
                console.log(`✅ PASS: Connection closed by server with code 1008: ${reason}`);
                closedCorrectly = true;
                resolve(true);
            }
        });

        setTimeout(() => {
            if (!closedCorrectly) {
                console.error(`❌ FAIL: Connection did not get closed for NaN timestamp!`);
                ws.close();
                resolve(false);
            }
        }, 1500);
    });
}

function startDummyHttpServer(port) {
    return new Promise((resolve) => {
        const srv = http.createServer((req, res) => {
            // Echo back headers so we can see what the proxy sent us
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(req.headers));
        });
        srv.listen(port, () => {
            console.log(`Dummy HTTP server listening on ${port}`);
            resolve(srv);
        });
    });
}

async function testKeepAliveConnectionClose() {
    console.log("\n--- Testing HTTP Proxy Keep-Alive Injection ---");

    const UPSTREAM_PORT = 9999;
    const upstreamServer = await startDummyHttpServer(UPSTREAM_PORT);

    return new Promise((resolve) => {
        let clientProcess = spawn('node', [path.join(__dirname, 'client', 'raspberryClient.js')], {
            env: { ...process.env, SERVER_URL: `ws://localhost:${TUNNEL_PORT}`, BLOCK_LOCAL_NETWORK: 'false' },
            stdio: 'pipe'
        });

        clientProcess.stdout.on('data', d => {
            const msg = d.toString().trim();
            console.log(`[Client] ${msg}`);
            if (msg.includes('Connected to VPS Tunnel successfully.')) {
                // Client is ready, send the proxy request
                setTimeout(() => {
                    const socket2 = net.connect({ port: PROXY_PORT, host: 'localhost' }, () => {
                        socket2.write(`GET http://localhost:${UPSTREAM_PORT}/ HTTP/1.1\r\nHost: localhost:${UPSTREAM_PORT}\r\nConnection: keep-alive\r\n\r\n`);
                    });

                    let resData = "";
                    socket2.on('data', (d) => {
                        resData += d.toString();
                    });

                    socket2.on('end', () => {
                        console.log("Proxy connection closed by server.");
                        console.log("Response data:", resData);
                        if (resData.includes('connection":"close') || resData.toLowerCase().includes('connection: close')) {
                            console.log("✅ PASS: Upstream received Connection: close");
                            teardown(true);
                        } else {
                            console.error("❌ FAIL: Upstream did NOT receive Connection: close");
                            teardown(false);
                        }
                    });

                    const timer = setTimeout(() => {
                        console.error("❌ FAIL: Timeout waiting for proxy response.");
                        socket2.destroy();
                        teardown(false);
                    }, 3000);

                    function teardown(success) {
                        clearTimeout(timer);
                        upstreamServer.close();
                        clientProcess.kill();
                        resolve(success);
                    }
                }, 1000);
            }
        });

        clientProcess.stderr.on('data', d => console.error(`[Client Error] ${d.toString().trim()}`));
    });

}

async function runTests() {
    await setupServer();

    let allPassed = true;

    const nanPassed = await testNaNTimestamp();
    allPassed = allPassed && nanPassed;

    const keepAlivePassed = await testKeepAliveConnectionClose();
    allPassed = allPassed && keepAlivePassed;

    if (serverProcess) serverProcess.kill();

    if (allPassed) {
        console.log("\n🎉 ALL TESTS PASSED!");
        process.exit(0);
    } else {
        console.error("\n❌ SOME TESTS FAILED.");
        process.exit(1);
    }
}

runTests();
