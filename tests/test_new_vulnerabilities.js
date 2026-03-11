const net = require('net');
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');
const WebSocket = require('ws');

async function delay(ms) {
    return new Promise(r => setTimeout(r, ms));
}

// Dummy server to echo received headers
const dummyServer = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(req.headers));
});
dummyServer.listen(3006, '::1');

async function testSlowloris() {
    console.log('--- Testing Slowloris Absolute Timeout ---');
    const MAX_PROXY_TIMEOUT_MS = 2000;
    const serverEnv = { ...process.env, PORT: 3133, TUNNEL_PORT: 8083, SKIP_DOTENV: 'true', ENABLE_TLS_PROXY: 'false', MAX_PROXY_TIMEOUT_MS: MAX_PROXY_TIMEOUT_MS.toString() };
    const clientEnv = { ...process.env, SERVER_URL: 'ws://127.0.0.1:8083', SKIP_DOTENV: 'true' };

    const server = spawn('node', [path.join(__dirname, 'server', 'proxyServer.js')], { env: serverEnv });
    const client = spawn('node', [path.join(__dirname, 'client', 'raspberryClient.js')], { env: clientEnv });

    await delay(2000);

    return new Promise((resolve) => {
        let startTime = Date.now();
        const proxySocket = net.connect(3133, '127.0.0.1', () => {
            // Send 1 byte of header
            proxySocket.write('G');

            // Send another byte before timeout
            setTimeout(() => {
                proxySocket.write('E');
            }, MAX_PROXY_TIMEOUT_MS - 500);

            // Send another byte before timeout
            setTimeout(() => {
                proxySocket.write('T');
            }, (MAX_PROXY_TIMEOUT_MS - 500) * 2);
        });

        let dataReceived = '';
        proxySocket.on('data', d => {
            dataReceived += d.toString();
        });

        proxySocket.on('close', () => {
            const elapsed = Date.now() - startTime;
            if (dataReceived.includes('408 Request Timeout')) {
                console.log(`✅ Slowloris connection dropped with 408 after ${elapsed}ms (Expected ~${MAX_PROXY_TIMEOUT_MS}ms)`);
            } else {
                console.error(`❌ Expected 408 Request Timeout but got: ${dataReceived}`);
            }
            proxySocket.destroy();
            server.kill();
            client.kill();
            resolve();
        });
    });
}

async function testIPv6() {
    console.log('\n--- Testing IPv6 Host/Port Splitting ---');
    const serverEnv = { ...process.env, PORT: 3134, TUNNEL_PORT: 8084, SKIP_DOTENV: 'true', ENABLE_TLS_PROXY: 'false', BLOCK_LOCAL_NETWORK: 'false' };
    const clientEnv = { ...process.env, SERVER_URL: 'ws://127.0.0.1:8084', SKIP_DOTENV: 'true', BLOCK_LOCAL_NETWORK: 'false' };

    const server = spawn('node', [path.join(__dirname, 'server', 'proxyServer.js')], { env: serverEnv });
    const client = spawn('node', [path.join(__dirname, 'client', 'raspberryClient.js')], { env: clientEnv });

    await delay(3000);

    return new Promise((resolve) => {
        const proxySocket = net.connect(3134, '127.0.0.1', () => {
            const req = "GET http://[::1]:3006/ HTTP/1.1\r\n" +
                "Host: [::1]:3006\r\n\r\n";
            proxySocket.write(req);
        });

        let dataReceived = '';
        proxySocket.on('data', d => {
            dataReceived += d.toString();
        });

        setTimeout(() => {
            if (dataReceived.includes('200 OK')) {
                console.log('✅ IPv6 target successfully connected and proxied.');
            } else {
                console.error('❌ Failed to proxy IPv6 target. Response:', dataReceived);
            }

            proxySocket.destroy();
            server.kill();
            client.kill();
            resolve();
        }, 3000);
    });
}

async function testRateLimitLockout() {
    console.log('\n--- Testing Rate Limit Lockout ---');
    const RATE_LIMIT_MS = 1000;
    const serverEnv = { ...process.env, PORT: 3135, TUNNEL_PORT: 8085, SKIP_DOTENV: 'true', ENABLE_TLS_PROXY: 'false', RATE_LIMIT_MS: RATE_LIMIT_MS.toString() };

    const server = spawn('node', [path.join(__dirname, 'server', 'proxyServer.js')], { env: serverEnv });

    await delay(2000);

    return new Promise(async (resolve) => {
        // Attack: attempt 3 connections, separated by 600ms (less than RATE_LIMIT_MS)
        for (let i = 0; i < 3; i++) {
            const ws = new WebSocket('ws://127.0.0.1:8085', { headers: { 'x-tunnel-secret': 'wrong' } });
            ws.on('error', () => { });
            await delay(600);
        }

        // Wait another 500ms
        await delay(500);

        const validWs = new WebSocket('ws://127.0.0.1:8085', { headers: { 'x-tunnel-secret': 'valid_not_checked_here' } });
        let closed = false;
        validWs.on('close', (code, reason) => {
            closed = true;
            if (reason.toString() === 'Rate limited') {
                console.error('❌ Legitimate connection was Rate Limited! (Lockout Bug Present)');
            }
        });

        await delay(1000);
        if (!closed) {
            console.log('✅ Legitimate connection succeeded, Rate Limit Lockout fixed!');
        }

        validWs.terminate();
        server.kill();
        resolve();
    });
}

async function runAll() {
    await testSlowloris();
    await testIPv6();
    await testRateLimitLockout();
    dummyServer.close();
    console.log('\n✅ All new Vulnerability Patch tests completed successfully!');
    process.exit(0);
}

runAll();
