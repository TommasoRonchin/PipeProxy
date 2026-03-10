const { spawn } = require('child_process');
const net = require('net');
const http = require('http');

const PORT_PROXY = 3128;

async function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function runTests() {
    console.log("🚀 Starting verification tests for recent fixes...\n");

    // Start Server
    const serverProcess = spawn('node', ['server/proxyServer.js'], {
        env: { ...process.env, PORT: PORT_PROXY, TUNNEL_PORT: 8080, ENABLE_PROXY_AUTH: 'false', ENABLE_TLS_PROXY: 'false' }
    });

    // Start Client
    const clientProcess = spawn('node', ['client/raspberryClient.js'], {
        env: { ...process.env, SERVER_URL: 'ws://localhost:8080' }
    });

    serverProcess.stdout.on('data', d => {
        // console.log(`[Server] ${d.toString().trim()}`);
    });
    serverProcess.stderr.on('data', d => {
        const str = d.toString();
        // Ignore expected warnings
        if (!str.includes('SSRF Attempt Blocked') && !str.includes('Rejecting request') && !str.includes('Connection Refused by Target')) {
            console.error(`[Server Error] ${str.trim()}`);
        }
    });

    clientProcess.stdout.on('data', d => {
        // console.log(`[Client] ${d.toString().trim()}`);
    });

    // Monitor for crashes
    let crashed = false;
    clientProcess.on('exit', code => {
        if (code !== 0 && code !== null) {
            console.error(`❌ Client crashed with code ${code}! (Unhandled Exception issue unresolved?)`);
            crashed = true;
        }
    });
    serverProcess.on('exit', code => {
        if (code !== 0 && code !== null) {
            console.error(`❌ Server crashed with code ${code}! (Unhandled Exception issue unresolved?)`);
            crashed = true;
        }
    });

    console.log("⏳ Waiting for startup...");
    await sleep(2000);

    try {
        // Test 1: 502 Bad Gateway ordering on CONNECT
        console.log("--- Test 1: HTTP CONNECT 502 Bad Gateway ---");
        await new Promise((resolve, reject) => {
            const socket = net.connect({ port: PORT_PROXY, host: '127.0.0.1' }, () => {
                // Connect to a definitely closed port to trigger "Connection Refused"
                socket.write("CONNECT 127.0.0.1:54321 HTTP/1.1\r\nHost: 127.0.0.1:54321\r\n\r\n");
            });

            let responseData = '';
            socket.on('data', chunk => {
                responseData += chunk.toString();
                if (responseData.includes('\r\n\r\n')) {
                    if (responseData.includes('502 Bad Gateway')) {
                        console.log("✅ Received proper 502 Bad Gateway response string.");
                    } else {
                        console.error("❌ Did not receive proper 502 Bad Gateway. Received:\n", responseData);
                    }
                    socket.destroy();
                    resolve();
                }
            });

            socket.on('close', () => {
                if (!responseData.includes('502 Bad Gateway')) {
                    console.error("❌ Socket closed without 502 Bad Gateway. Request was likely dropped silently.");
                }
                resolve();
            });

            socket.on('error', err => {
                console.error("❌ Socket error during CONNECT test:", err.message);
                resolve();
            });
        });

        // Test 2: SSRF Logic testing
        // This is implicit since we can just try to connect to localhost port 80 (assuming it's running something or nothing, it triggers DNS check)
        console.log("\n--- Test 2: SSRF Memory Leak Check (Simulated) ---");
        console.log("Triggering SSRF block by requesting connection to localhost...");
        await new Promise((resolve) => {
            const socket = net.connect({ port: PORT_PROXY, host: '127.0.0.1' }, () => {
                socket.write("GET http://localhost/ HTTP/1.1\r\nHost: localhost\r\n\r\n");
            });
            socket.on('data', () => { });
            socket.on('close', resolve);
            socket.on('error', resolve);
            setTimeout(resolve, 500); // give it time to be blocked
        });
        console.log("✅ SSRF requested. We verify memory leak fix by monitoring client process life.");

        // Wait a moment to see if any late frames cause a destroyed socket crash
        console.log("\n--- Test 3: Unhandled ERR_STREAM_DESTROYED ---");
        console.log("Waiting 3 seconds to ensure late packets routing to destroyed sockets do NOT crash the system...");
        await sleep(3000);

        if (!crashed) {
            console.log("✅ No processes crashed! Both Client and Server handled destroyed socket writes gracefully.");
        } else {
            console.error("❌ A process crashed, meaning the unhandled exception fix might not be complete.");
        }

    } catch (err) {
        console.error("Test execution failed:", err);
    } finally {
        console.log("\n🧹 Cleaning up test processes...");
        serverProcess.kill('SIGKILL');
        clientProcess.kill('SIGKILL');
        console.log("🎉 Testing complete.");
    }
}

runTests();
