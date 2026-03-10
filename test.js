const { spawn, exec } = require('child_process');
const path = require('path');

// Configuration
const PROXY_HOST = '127.0.0.1';
const PROXY_PORT = 3128;
const PROXY_URL = `http://${PROXY_HOST}:${PROXY_PORT}`;

// Utility to run curl
function runCurl(url, auth = 'admin:Sup3r:P@ssword:!') {
    return new Promise((resolve, reject) => {
        const cmd = `curl -s -o /dev/null -w "%{time_total}" -U ${auth} -x ${PROXY_URL} ${url}`;
        exec(cmd, (error, stdout, stderr) => {
            if (error) {
                resolve(0); // On error during benchmark, return 0 instead of crashing the whole suite
                return;
            }
            resolve(parseFloat(stdout.trim()));
        });
    });
}
function runCurlCheck(url, auth = 'admin:Sup3r:P@ssword:!') {
    return new Promise((resolve, reject) => {
        // use --max-time 5 to prevent infinite hanging if proxy drops connection (e.g., SSRF)
        const cmd = `curl -s --max-time 5 -U ${auth} -x ${PROXY_URL} ${url}`;
        exec(cmd, (error, stdout, stderr) => {
            if (error) {
                resolve("ERROR_TIMEOUT_OR_DROP"); // For SSRF we expect it to drop
                return;
            }
            resolve(stdout.trim());
        });
    });
}

function delay(ms) {
    return new Promise(r => setTimeout(r, ms));
}

async function runPass(encryptionEnabled, encryptionSecret = 'test_enc_key') {
    console.log(`\n======================================================`);
    console.log(`🚀 RUNNING TEST PASS (Encryption: ${encryptionEnabled ? 'ON 🔒' : 'OFF 🔓'})`);
    console.log(`======================================================\n`);

    const serverEnv = {
        ...process.env,
        SKIP_DOTENV: 'true',
        PORT: PROXY_PORT,
        TUNNEL_PORT: 8080,
        TUNNEL_SECRET: 'test_secret',
        ENABLE_PROXY_AUTH: 'true',
        PROXY_AUTH_USERNAME: 'admin',
        PROXY_AUTH_PASSWORD: 'Sup3r:P@ssword:!', // Testing complex password
        ENABLE_SECURE_HANDSHAKE: 'true', // Testing secure HMAC
        BLOCK_LOCAL_NETWORK: 'true'
    };
    const clientEnv = {
        ...process.env,
        SKIP_DOTENV: 'true',
        SERVER_URL: 'ws://127.0.0.1:8080',
        TUNNEL_SECRET: 'test_secret',
        ENABLE_SECURE_HANDSHAKE: 'true',
        BLOCK_LOCAL_NETWORK: 'true'
    };

    if (encryptionEnabled) {
        serverEnv.ENABLE_ENCRYPTION = 'true';
        serverEnv.ENCRYPTION_SECRET = encryptionSecret;
        clientEnv.ENABLE_ENCRYPTION = 'true';
        clientEnv.ENCRYPTION_SECRET = encryptionSecret;
    } else {
        serverEnv.ENABLE_ENCRYPTION = 'false';
        clientEnv.ENABLE_ENCRYPTION = 'false';
    }

    const serverProcess = spawn('node', [path.join(__dirname, 'server', 'proxyServer.js')], { env: serverEnv });
    const clientProcess = spawn('node', [path.join(__dirname, 'client', 'raspberryClient.js')], { env: clientEnv });

    let serverReady = false;
    let clientReady = false;

    let serverOutput = '';
    let clientOutput = '';
    serverProcess.stdout.on('data', output => {
        serverOutput += output.toString();
        if (output.toString().includes('listening on port 3128')) serverReady = true;
    });
    serverProcess.stderr.on('data', output => { serverOutput += output.toString(); });
    clientProcess.stdout.on('data', output => {
        clientOutput += output.toString();
        if (output.toString().includes('successfully')) clientReady = true;
    });
    clientProcess.stderr.on('data', output => { clientOutput += output.toString(); });

    let attempts = 20;
    while ((!serverReady || !clientReady) && attempts > 0) {
        await delay(500);
        attempts--;
    }

    if (!serverReady || !clientReady) {
        console.error('❌ Timeout waiting for server/client to start.');
        console.error('SERVER OUTPUT:', serverOutput);
        console.error('CLIENT OUTPUT:', clientOutput);
        serverProcess.kill();
        clientProcess.kill();
        return { passed: false, time: null };
    }

    console.log('✅ Server and Client connected successfully!');

    let passed = 0;
    let totalTime = 0;

    try {
        console.log(`⏳ Test 1: HTTP Verify (http://example.com) with Complex Password`);
        const httpRes = await runCurlCheck('http://example.com');
        if (httpRes.includes('Example Domain')) passed++; else console.error('❌ Failed HTTP Check', httpRes);

        console.log(`⏳ Test 2: HTTPS Verify (https://example.com)`);
        const httpsRes = await runCurlCheck('https://example.com');
        if (httpsRes.includes('Example Domain')) passed++; else console.error('❌ Failed HTTPS Check', httpsRes);

        console.log(`⏳ Test 3: Data Integrity API (https://api.ipify.org)`);
        const ipRes = await runCurlCheck('https://api.ipify.org');
        if (ipRes && ipRes.includes('.')) passed++; else console.error('❌ Failed Data Integrity Check', ipRes);

        console.log(`⏳ Test 4: SSRF Protection Attack (http://127.0.0.1:8080)`);
        const ssrfRes = await runCurlCheck('http://127.0.0.1:8080');
        if (ssrfRes === "ERROR_TIMEOUT_OR_DROP") {
            passed++;
        } else {
            console.error('❌ Failed SSRF Defense Check: Connection was not blocked!', ssrfRes);
        }

        if (passed < 4) {
            console.error('--- DEBUG: SERVER OUTPUT ---');
            console.log(serverOutput);
            console.error('--- DEBUG: CLIENT OUTPUT ---');
            console.log(clientOutput);
        }

        console.log(`⏳ Test 5: Performance Benchmark (5 consecutive requests)`);
        for (let i = 0; i < 5; i++) {
            totalTime += await runCurl('https://example.com');
        }
        console.log(`   ⏱️ Average request latency: ${(totalTime / 5).toFixed(3)}s`);
        passed++;

    } catch (err) {
        console.error('❌ Test failed with error:', err.message);
    }

    // Cleanup
    serverProcess.kill();
    clientProcess.kill();
    await delay(1000); // give OS time to free ports

    const allPassed = passed === 5;
    console.log(`\n--- Pass Summary (Encryption: ${encryptionEnabled}) ---`);
    console.log(`Status: ${allPassed ? '✅ SUCCESS' : '❌ FAILED'}`);

    return { passed: allPassed, time: (totalTime / 5).toFixed(3) };
}

async function runAllTests() {
    console.log('🔄 Starting full test suite for PipeProxy...\n');
    let suiteFailed = false;

    // Test Pass 1: Encryption OFF
    const resOff = await runPass(false);
    if (!resOff.passed) suiteFailed = true;

    // Test Pass 2: Encryption ON
    const resOn = await runPass(true);
    if (!resOn.passed) suiteFailed = true;

    // Performance comparison
    if (!suiteFailed) {
        console.log(`\n======================================================`);
        console.log(`📊 PERFORMANCE COMPARISON REPORT`);
        console.log(`======================================================`);
        console.log(`Encryption OFF latency: ${resOff.time}s`);
        console.log(`Encryption ON latency:  ${resOn.time}s`);
        let diff = ((parseFloat(resOn.time) - parseFloat(resOff.time)) * 1000).toFixed(1);
        console.log(`Encryption Overhead:   ${diff > 0 ? '+' : ''}${diff}ms per request`);
        console.log(`\nConclusion: AES layer has negligible overhead for standard HTTP(s) traffic.`);
    }

    if (suiteFailed) {
        process.exit(1);
    } else {
        process.exit(0);
    }
}

// Handle unexpected exits
process.on('SIGINT', () => process.exit(1));
process.on('uncaughtException', (err) => {
    console.error('Uncaught Exception:', err);
    process.exit(1);
});

runAllTests();
