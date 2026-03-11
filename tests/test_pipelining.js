const net = require('net');
const http = require('http');
const { spawn } = require('child_process');

process.env.PROXY_AUTH_USERNAME = 'admin';
process.env.PROXY_AUTH_PASSWORD = 'password';
process.env.ENABLE_PROXY_AUTH = 'true';
process.env.PORT = '8128';
process.env.TUNNEL_PORT = '8180';
process.env.SERVER_URL = 'ws://localhost:8180';
process.env.BLOCK_LOCAL_NETWORK = 'false';
process.env.FORCE_CONNECTION_CLOSE = 'false';

// Start Server and Client dynamically
const serverProc = spawn('node', ['server/proxyServer.js'], { env: process.env, stdio: 'ignore' });
const clientProc = spawn('node', ['client/raspberryClient.js'], { env: process.env, stdio: 'ignore' });

let dummyServer;
let targetPort = 9991;

console.log("Starting HTTP Pipelining Leak Test...");

dummyServer = http.createServer((req, res) => {
    // Check headers of incoming requests to the target destination
    if (req.headers['proxy-authorization']) {
        console.error(`❌ VULNERABILITY DETECTED! Proxy-Authorization leaked to destination on path: ${req.url}`);
        process.exit(1);
    } else {
        console.log(`✅ Secure: No Proxy-Authorization in request to ${req.url}`);
    }
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('OK');
});

dummyServer.listen(targetPort, () => {
    setTimeout(() => {
        // Connect to proxy
        const client = new net.Socket();
        client.connect(parseInt(process.env.PORT), '127.0.0.1', () => {
            console.log("Connected to proxy. Sending pipelined requests...");

            const authHeader = 'Proxy-Authorization: Basic ' + Buffer.from('admin:password').toString('base64');

            // Craft pipelined payload
            const req1 = `GET http://127.0.0.1:${targetPort}/req1 HTTP/1.1\r\nHost: 127.0.0.1:${targetPort}\r\n${authHeader}\r\nConnection: keep-alive\r\n\r\n`;
            const req2 = `GET http://127.0.0.1:${targetPort}/req2 HTTP/1.1\r\nHost: 127.0.0.1:${targetPort}\r\n${authHeader}\r\nConnection: close\r\n\r\n`;

            // Send both at once (pipelining)
            client.write(req1 + req2);
        });

        let responses = 0;
        client.on('data', (data) => {
            const str = data.toString();
            if (str.includes('200 OK')) {
                responses++;
            }
            if (responses === 2) {
                console.log("🎉 Test passed. Both responses received and no leaks detected.");
                cleanup(0);
            }
        });

        client.on('error', (err) => {
            console.error("Client error:", err);
            cleanup(1);
        });

    }, 2000); // Wait 2s for proxy to boot
});

function cleanup(code) {
    serverProc.kill();
    clientProc.kill();
    dummyServer.close();
    process.exit(code);
}

setTimeout(() => {
    console.error("Timeout!");
    cleanup(1);
}, 6000);
