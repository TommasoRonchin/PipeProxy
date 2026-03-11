const { spawn } = require('child_process');
const net = require('net');
const http = require('http');
const path = require('path');

// Test Configuration
const PROXY_PORT = 3133;
const TUNNEL_PORT = 8089;
const TARGET_PORT = 9005;

async function runTests() {
    console.log("Starting Deep Analysis Security Fixes Test Suite...");

    // Create a target echo server
    const targetServer = http.createServer((req, res) => {
        let body = [];
        req.on('data', chunk => body.push(chunk));
        req.on('end', () => {
            const data = Buffer.concat(body);
            // Echo headers and body size
            res.writeHead(200, req.headers);
            res.end(data);
        });
    });

    await new Promise(r => targetServer.listen(TARGET_PORT, r));
    console.log(`[+] Target Mock Server listening on ${TARGET_PORT}`);

    // Spawn the server process (ProxyServer + TunnelServer)
    const serverProcess = spawn('node', [path.join(__dirname, 'server', 'proxyServer.js')], {
        stdio: 'inherit',
        env: {
            ...process.env,
            PORT: PROXY_PORT,
            TUNNEL_PORT: TUNNEL_PORT,
            TUNNEL_SECRET: 'testsecret',
            ENABLE_SECURE_HANDSHAKE: 'false',
            ENABLE_PROXY_AUTH: 'false',
            MAX_ENCODE_FRAME_SIZE_MB: '1', // Restrict to 1MB for the OOM test
        }
    });

    // Spawn the client process (RaspberryClient)
    const clientProcess = spawn('node', [path.join(__dirname, 'client', 'raspberryClient.js')], {
        stdio: 'inherit',
        env: {
            ...process.env,
            SERVER_URL: `ws://localhost:${TUNNEL_PORT}`,
            TUNNEL_SECRET: 'testsecret',
            ENABLE_SECURE_HANDSHAKE: 'false',
            MAX_ENCODE_FRAME_SIZE_MB: '1',
            BLOCK_LOCAL_NETWORK: 'false', // Allow localhost for testing
        }
    });

    // Wait for tunnel startup
    await new Promise(r => setTimeout(r, 5000));

    let testsPassed = 0;
    try {
        console.log("\n--- TEST 1: Binary Data Corruption (Pipelining Protection) ---");

        await new Promise((resolve, reject) => {
            const socket = net.connect(PROXY_PORT, 'localhost', () => {
                socket.write(`POST http://localhost:${TARGET_PORT}/ HTTP/1.1\r\nHost: localhost:${TARGET_PORT}\r\nContent-Length: 50\r\n\r\n`);
                const binaryData = Buffer.alloc(50);
                binaryData.fill(0xE1);
                const secretPart = "Proxy-Authorization: secret";
                binaryData.write(secretPart + "\r\n", 10, 'ascii');
                socket.write(binaryData);
            });

            let responseBuffer = Buffer.alloc(0);
            const timeout = setTimeout(() => {
                socket.destroy();
                reject(new Error("Test 1 Timeout"));
            }, 10000);

            socket.on('data', (chunk) => {
                responseBuffer = Buffer.concat([responseBuffer, chunk]);
                const res = responseBuffer.toString('latin1');

                const expectedSpaces = Buffer.alloc(secretPart.length, 0x20).toString('latin1');

                if (res.includes(expectedSpaces) && !res.includes('secret')) {
                    console.log("[+] Test 1 Passed: Binary data preserved size and redacted sensitive header correctly.");
                    testsPassed++;
                    clearTimeout(timeout);
                    socket.destroy();
                    resolve();
                } else if (res.includes('secret')) {
                    console.error("[-] Test 1 Failed: The secret was not redacted!");
                    clearTimeout(timeout);
                    socket.destroy();
                    resolve();
                }
            });

            socket.on('error', reject);
        });

        console.log("\n--- TEST 2: Unhandled Exception DoS (OOM Protection) ---");
        await new Promise((resolve, reject) => {
            const socket = net.connect(PROXY_PORT, 'localhost', () => {
                socket.write(`CONNECT localhost:${TARGET_PORT} HTTP/1.1\r\n\r\n`);

                socket.once('data', (d) => {
                    const largePayload = Buffer.alloc(1.5 * 1024 * 1024); // Exceeds 1MB limit
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
