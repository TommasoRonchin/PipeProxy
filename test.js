const { spawn, exec } = require('child_process');
const path = require('path');

// Configuration
const PROXY_HOST = '127.0.0.1';
const PROXY_PORT = 3128;
const PROXY_URL = `http://${PROXY_HOST}:${PROXY_PORT}`;

console.log('🔄 Starting end-to-end test for PipeProxy...');

// 1. Start Server
const serverProcess = spawn('node', [path.join(__dirname, 'server', 'proxyServer.js')], {
    env: { ...process.env, PORT: PROXY_PORT, TUNNEL_PORT: 8080, TUNNEL_SECRET: 'test_secret' }
});

let serverReady = false;
serverProcess.stdout.on('data', (data) => {
    const output = data.toString();
    // console.log('[Server]', output.trim());
    if (output.includes('listening on port 3128')) {
        serverReady = true;
    }
});
serverProcess.stderr.on('data', (data) => console.error('[Server Error]', data.toString().trim()));

// 2. Start Client
const clientProcess = spawn('node', [path.join(__dirname, 'client', 'raspberryClient.js')], {
    env: { ...process.env, SERVER_URL: 'ws://127.0.0.1:8080', TUNNEL_SECRET: 'test_secret' }
});

let clientReady = false;
clientProcess.stdout.on('data', (data) => {
    const output = data.toString();
    // console.log('[Client]', output.trim());
    if (output.includes('Connected to VPS Tunnel successfully.')) {
        clientReady = true;
    }
});
clientProcess.stderr.on('data', (data) => console.error('[Client Error]', data.toString().trim()));

// Utility to run curl
function runCurl(url) {
    return new Promise((resolve, reject) => {
        // Using curl.exe directly to avoid PowerShell Invoke-WebRequest aliasing if run differently,
        // though child_process.exec runs in cmd.exe where 'curl' is the native curl.exe usually.
        const cmd = `curl -s -x ${PROXY_URL} ${url}`;
        exec(cmd, (error, stdout, stderr) => {
            if (error) {
                reject(error);
                return;
            }
            resolve(stdout.trim());
        });
    });
}

// 3. Wait for readiness and run tests
async function runTests() {
    // Wait for both to be ready
    let attempts = 20;
    while ((!serverReady || !clientReady) && attempts > 0) {
        await new Promise(r => setTimeout(r, 500));
        attempts--;
    }

    if (!serverReady || !clientReady) {
        console.error('❌ Timeout waiting for server/client to start.');
        console.error(`Server ready: ${serverReady}, Client ready: ${clientReady}`);
        cleanup();
        process.exit(1);
    }

    console.log('✅ Server and Client connected successfully via WebSocket!');

    let passed = 0;
    let failed = 0;

    try {
        console.log(`\n⏳ Test 1: HTTP Proxy Request (http://example.com)`);
        const httpRes = await runCurl('http://example.com');
        if (httpRes.includes('Example Domain')) {
            console.log('✅ HTTP test passed!');
            passed++;
        } else {
            console.error('❌ HTTP test failed: Unexpected response:', httpRes.substring(0, 100));
            failed++;
        }
    } catch (err) {
        console.error('❌ HTTP test failed with error:', err.message);
        failed++;
    }

    try {
        console.log(`\n⏳ Test 2: HTTPS Proxy Request (https://example.com)`);
        const httpsRes = await runCurl('https://example.com');
        if (httpsRes.includes('Example Domain')) {
            console.log('✅ HTTPS test passed!');
            passed++;
        } else {
            console.error('❌ HTTPS test failed: Unexpected response:', httpsRes.substring(0, 100));
            failed++;
        }
    } catch (err) {
        console.error('❌ HTTPS test failed with error:', err.message);
        failed++;
    }

    try {
        console.log(`\n⏳ Test 3: HTTPS Proxy Request to external API (https://api.ipify.org)`);
        const ipRes = await runCurl('https://api.ipify.org');
        // Check if it's a valid IPv4 or IPv6
        const ipRegex = /^[0-9a-fA-F.:]+$/;
        if (ipRegex.test(ipRes)) {
            console.log(`✅ External API test passed! Returned IP: ${ipRes}`);
            passed++;
        } else {
            console.error('❌ External API test failed: Unexpected response:', ipRes);
            failed++;
        }
    } catch (err) {
        console.error('❌ External API test failed with error:', err.message);
        failed++;
    }

    console.log(`\n--- Test Summary ---`);
    console.log(`✅ Passed: ${passed}`);
    console.log(`❌ Failed: ${failed}`);

    cleanup();
    if (failed > 0) {
        process.exit(1);
    } else {
        process.exit(0);
    }
}

function cleanup() {
    serverProcess.kill();
    clientProcess.kill();
}

// Handle unexpected exits
process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);
process.on('uncaughtException', (err) => {
    console.error('Uncaught Exception:', err);
    cleanup();
    process.exit(1);
});

runTests();
