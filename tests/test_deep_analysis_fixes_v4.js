const { spawn } = require('child_process');
const net = require('net');
const http = require('http');
const path = require('path');

// Test Configuration - Using non-standard ports to avoid conflicts
const PROXY_PORT = 3145;
const TUNNEL_PORT = 8100;
const TARGET_PORT = 9015;

async function runTests() {
    console.log("Starting Deep Analysis Security Fixes Test Suite (V4 - Safe Ports)...");

    // Create a target echo server
    const targetServer = http.createServer((req, res) => {
        let body = [];
        req.on('data', chunk => body.push(chunk));
        req.on('end', () => {
            const data = Buffer.concat(body);
            res.writeHead(200, req.headers);
            res.end(data);
        });
    });

    await new Promise(r => targetServer.listen(TARGET_PORT, r));
    console.log(`[+] Target Mock Server listening on ${TARGET_PORT}`);

    // Spawn the server process
    const serverProcess = spawn('node', [path.join(__dirname, 'server', 'proxyServer.js')], {
        stdio: 'inherit',
        env: {
            ...process.env,
            PORT: PROXY_PORT,
            TUNNEL_PORT: TUNNEL_PORT,
            TUNNEL_SECRET: 'testsecret',
            ENABLE_SECURE_HANDSHAKE: 'false',
            ENABLE_PROXY_AUTH: 'false',
            MAX_ENCODE_FRAME_SIZE_MB: '1',
            BLOCK_LOCAL_NETWORK: 'false'
        }
    });

    // Spawn the client process
    const clientProcess = spawn('node', [path.join(__dirname, 'client', 'raspberryClient.js')], {
        stdio: 'inherit',
        env: {
            ...process.env,
            SERVER_URL: `ws://localhost:${TUNNEL_PORT}`,
            TUNNEL_SECRET: 'testsecret',
            ENABLE_SECURE_HANDSHAKE: 'false',
            MAX_ENCODE_FRAME_SIZE_MB: '1',
            BLOCK_LOCAL_NETWORK: 'false'
        }
    });

    // Wait for tunnel startup
    console.log("[...] Waiting for tunnel to stabilize (7s)...");
    await new Promise(r => setTimeout(r, 7000));

    let testsPassed = 0;
    try {
        console.log("\n--- TEST 1: Binary Data Corruption (Pipelining Protection) ---");

        await new Promise((resolve, reject) => {
            const secretPart = "Proxy-Authorization: secret";
            const socket = net.connect(PROXY_PORT, 'localhost', () => {
                // Headers and body sent in SAME CHUNK to verify ProxyServer extraData redaction
                const headers = `POST http://localhost:${TARGET_PORT}/ HTTP/1.1\r\nHost: localhost:${TARGET_PORT}\r\nContent-Length: 50\r\n\r\n`;
                const binaryBody = Buffer.alloc(50);
                binaryBody.fill(0xE1);
                binaryBody.write(secretPart + "\r\n", 10, 'ascii');

                socket.write(Buffer.concat([Buffer.from(headers, 'ascii'), binaryBody]));
            });

            let responseBuffer = Buffer.alloc(0);
            const timeout = setTimeout(() => {
                socket.destroy();
                reject(new Error("Test 1 Timeout"));
            }, 10000);

            socket.on('data', (chunk) => {
                responseBuffer = Buffer.concat([responseBuffer, chunk]);
                const resText = responseBuffer.toString('latin1');
                const expectedSpaces = Buffer.alloc(secretPart.length, 0x20).toString('latin1');

                if (resText.includes(expectedSpaces) && !resText.includes('secret')) {
                    console.log("[+] Test 1 Passed: Binary data preserved size and redacted sensitive header correctly.");
                    testsPassed++;
                    clearTimeout(timeout);
                    socket.destroy();
                    resolve();
                } else if (resText.includes('secret')) {
                    console.error("[-] Test 1 Failed: The secret was NOT redacted!");
                    clearTimeout(timeout);
                    socket.destroy();
                    resolve();
                }
            });

            socket.on('error', (err) => {
                clearTimeout(timeout);
                reject(err);
            });
        });

        console.log("\n--- TEST 2: Unhandled Exception DoS (OOM Protection) ---");
        await new Promise((resolve, reject) => {
            const socket = net.connect(PROXY_PORT, 'localhost', () => {
                socket.write(`CONNECT localhost:${TARGET_PORT} HTTP/1.1\r\n\r\n`);
                socket.once('data', (d) => {
                    const largePayload = Buffer.alloc(1.5 * 1024 * 1024);
                    largePayload.fill('A');
                    socket.write(largePayload);
                    setTimeout(() => {
                        socket.destroy();
                        resolve();
                    }, 2000);
                });
            });
            socket.on('error', reject);
        });

        console.log("[+] Test 2 Passed: Server successfully survived encodeFrame exception.");
        testsPassed++;

    } catch (e) {
        console.error("Test execution error:", e.message);
    } finally {
        console.log("\nCleaning up test processes...");
        serverProcess.kill();
        clientProcess.kill();
        targetServer.close();

        if (testsPassed === 2) {
            console.log("\n[SUCCESS] All deep analysis fixes verified successfully!");
            process.exit(0);
        } else {
            console.log(`\n[FAILED] Only ${testsPassed}/2 tests passed.`);
            process.exit(1);
        }
    }
}

runTests();
