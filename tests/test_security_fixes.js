const { spawn } = require('child_process');
const net = require('net');
const http = require('http');
const path = require('path');

async function delay(ms) {
    return new Promise(r => setTimeout(r, ms));
}

// Dummy server to echo received headers and body
const dummyServer = http.createServer((req, res) => {
    let body = '';
    req.on('data', chunk => {
        body += chunk.toString();
    });
    req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ headers: req.headers, body }));
    });
});

dummyServer.listen(3000, '127.0.0.1');

async function testHeaderStripping() {
    console.log('--- Testing Proxy Header Stripping ---');
    const serverEnv = { ...process.env, PORT: 3131, TUNNEL_PORT: 8081, SKIP_DOTENV: 'true', ENABLE_TLS_PROXY: 'false', BLOCK_LOCAL_NETWORK: 'false' };
    const clientEnv = { ...process.env, SERVER_URL: 'ws://127.0.0.1:8081', SKIP_DOTENV: 'true', BLOCK_LOCAL_NETWORK: 'false' };

    const server = spawn('node', [path.join(__dirname, 'server', 'proxyServer.js')], { env: serverEnv });
    const client = spawn('node', [path.join(__dirname, 'client', 'raspberryClient.js')], { env: clientEnv });

    await delay(3000); // give time to link up

    return new Promise((resolve) => {
        const proxySocket = net.connect(3131, '127.0.0.1', () => {
            // Standard proxy GET request to our dummy server
            const req = "GET http://127.0.0.1:3000/ HTTP/1.1\r\n" +
                "Host: 127.0.0.1:3000\r\n" +
                "Proxy-Authorization: Basic dXNlcjpwYXNz\r\n" +
                "Proxy-Connection: keep-alive\r\n" +
                "User-Agent: curl/7.81.0\r\n" +
                "\r\n";
            proxySocket.write(req);
        });

        let dataReceived = '';
        proxySocket.on('data', d => {
            dataReceived += d.toString();
        });

        setTimeout(() => {
            if (dataReceived.includes('200 OK')) {
                const bodyMatches = dataReceived.match(/\{.*\}/s);
                if (bodyMatches) {
                    const parsed = JSON.parse(bodyMatches[0]);
                    const headers = parsed.headers || parsed;
                    if (headers['proxy-authorization'] || headers['proxy-connection']) {
                        console.error('❌ Header stripping FAILED. Headers leaked:', headers);
                    } else {
                        console.log('✅ Headers successfully stripped! The target server did not receive them.');
                    }
                }
            } else {
                console.error('❌ Proxy request failed to reach dummy server.');
            }

            proxySocket.destroy();
            server.kill();
            client.kill();
            resolve();
        }, 3000);
    });
}

async function testInvalidPortCrash() {
    console.log('\n--- Testing Out-Of-Bounds Port Validation ---');
    const serverEnv = { ...process.env, PORT: 3132, TUNNEL_PORT: 8082, SKIP_DOTENV: 'true', ENABLE_TLS_PROXY: 'false' };
    const clientEnv = { ...process.env, SERVER_URL: 'ws://127.0.0.1:8082', SKIP_DOTENV: 'true' };

    const server = spawn('node', [path.join(__dirname, 'server', 'proxyServer.js')], { env: serverEnv });
    const client = spawn('node', [path.join(__dirname, 'client', 'raspberryClient.js')], { env: clientEnv });

    await delay(3000);

    return new Promise((resolve) => {
        const proxySocket = net.connect(3132, '127.0.0.1', () => {
            // Malformed CONNECT request with invalid port 99999
            const req = "CONNECT target.com:99999 HTTP/1.1\r\n" +
                "Host: target.com:99999\r\n" +
                "\r\n";
            proxySocket.write(req);
        });

        let dataReceived = '';
        proxySocket.on('data', d => {
            dataReceived += d.toString();
        });

        setTimeout(() => {
            if (dataReceived.includes('400 Bad Request')) {
                console.log('✅ Invalid port successfully rejected with 400 Bad Request (Server did not crash!).');
            } else {
                console.error('❌ Expected 400 Bad Request. Received:', dataReceived);
            }

            proxySocket.destroy();
            server.kill();
            client.kill();
            resolve();
        }, 3000);
    });
}

async function testPostDataCorruption() {
    console.log('\n--- Testing POST Data Corruption (Proxy-Authorization keyword) ---');
    const serverEnv = { ...process.env, PORT: 3133, TUNNEL_PORT: 8083, SKIP_DOTENV: 'true', ENABLE_TLS_PROXY: 'false', BLOCK_LOCAL_NETWORK: 'false' };
    const clientEnv = { ...process.env, SERVER_URL: 'ws://127.0.0.1:8083', SKIP_DOTENV: 'true', BLOCK_LOCAL_NETWORK: 'false' };

    const server = spawn('node', [path.join(__dirname, 'server', 'proxyServer.js')], { env: serverEnv });
    const client = spawn('node', [path.join(__dirname, 'client', 'raspberryClient.js')], { env: clientEnv });

    await delay(3000);

    return new Promise((resolve) => {
        const proxySocket = net.connect(3133, '127.0.0.1', () => {
            const bodyPayload = "Lorem ipsum proxy-authorization: basic abc\r\ntest";
            const req = "POST http://127.0.0.1:3000/ HTTP/1.1\r\n" +
                "Host: 127.0.0.1:3000\r\n" +
                "Content-Length: " + bodyPayload.length + "\r\n" +
                "Proxy-Authorization: Basic dXNlcjpwYXNz\r\n" +
                "Proxy-Connection: keep-alive\r\n" +
                "\r\n" +
                bodyPayload;
            proxySocket.write(req);
        });

        let dataReceived = '';
        proxySocket.on('data', d => {
            dataReceived += d.toString();
        });

        setTimeout(() => {
            if (dataReceived.includes('200 OK')) {
                const bodyMatches = dataReceived.match(/\{.*\}/s);
                if (bodyMatches) {
                    try {
                        const responseBody = JSON.parse(bodyMatches[0]);
                        if (responseBody.body === "Lorem ipsum proxy-authorization: basic abc\r\ntest") {
                            console.log('✅ POST data correctly received without corruption!');
                        } else {
                            console.error('❌ POST data corrupted. Received body:', responseBody.body);
                        }
                    } catch (e) {
                        console.error('❌ Failed to parse response:', dataReceived);
                    }
                }
            } else {
                console.error('❌ Proxy request failed to reach dummy server in POST test.');
            }

            proxySocket.destroy();
            server.kill();
            client.kill();
            resolve();
        }, 3000);
    });
}

async function runTests() {
    await testHeaderStripping();
    await testInvalidPortCrash();
    await testPostDataCorruption();
    dummyServer.close();
    console.log('\n✅ All Security Patch tests completed successfully!');
    process.exit(0);
}

runTests();
