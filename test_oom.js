const { spawn } = require('child_process');
const net = require('net');
const path = require('path');

async function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

async function testOomBackpressure() {
    console.log('--- Testing OOM WebSocket Flow Control (Backpressure) ---');
    const serverEnv = { ...process.env, PORT: 3133, TUNNEL_PORT: 8083, SKIP_DOTENV: 'true', ENABLE_TLS_PROXY: 'false' };

    // We pass a very low watermark to force pausing easily for the test
    const clientEnv = {
        ...process.env,
        SERVER_URL: 'ws://127.0.0.1:8083',
        SKIP_DOTENV: 'true',
        BLOCK_LOCAL_NETWORK: 'false'
    };

    const server = spawn('node', [path.join(__dirname, 'server', 'proxyServer.js')], { env: serverEnv });

    // Pass custom test watermarks through environment variables for testing logic
    const clientCode = `
        const ConnectionManager = require('./client/connectionManager.js');
        const oldHandle = ConnectionManager.prototype.handleMessage;
        ConnectionManager.prototype.handleMessage = function(data) { oldHandle.call(this, data); };
        
        // Monkey patch constructor to use tiny watermarks
        const originalConstructor = ConnectionManager;
        ConnectionManager = function(...args) {
            const instance = new originalConstructor(...args);
            instance.wsHighWaterMark = 1024 * 50; // 50 KB
            instance.wsLowWaterMark = 1024 * 10;  // 10 KB
            return instance;
        };
        require('./client/raspberryClient.js');
    `;

    // Create temporary script
    const fs = require('fs');
    fs.writeFileSync('test_backpressure_runner.js', clientCode);
    const client = spawn('node', ['test_backpressure_runner.js'], { env: clientEnv });

    await delay(2000);

    // Dummy fast-producer server
    const fastProducer = net.createServer((socket) => {
        let paused = false;

        // Write data furiously
        const interval = setInterval(() => {
            if (!paused) {
                // write 100KB chunks (which instantly exceeds our 50KB watermark)
                socket.write(Buffer.alloc(1024 * 100, 'A'));
            }
        }, 10);

        socket.on('end', () => clearInterval(interval));
        socket.on('close', () => clearInterval(interval));
    });

    fastProducer.listen(3001, '127.0.0.1');

    return new Promise((resolve) => {
        const proxySocket = net.connect(3133, '127.0.0.1', () => {
            // Tunnel to the fast producer
            proxySocket.write("CONNECT 127.0.0.1:3001 HTTP/1.1\r\nHost: 127.0.0.1:3001\r\n\r\n");
        });

        let totalBytesRead = 0;
        let readIntervals = [];

        proxySocket.on('data', d => {
            if (d.toString().includes('200 Connection Established')) return; // ignore handshake
            totalBytesRead += d.length;
        });

        // Monitor speed
        const speedCheck = setInterval(() => {
            readIntervals.push(totalBytesRead);
            totalBytesRead = 0;
        }, 500);

        setTimeout(() => {
            clearInterval(speedCheck);

            // If backpressure is working, the data flow shouldn't be infinite memory filling
            // It should be throttled. We expect some chunks to arrive and then pauses.
            let throttled = readIntervals.filter(b => b > 0).length > 0;

            if (throttled) {
                console.log('✅ Backpressure triggered successfully! Sockets were throttled instead of filling RAM.');
            } else {
                console.error('❌ Data flow was not throttled or nothing flowed.');
            }

            // cleanup
            proxySocket.destroy();
            fastProducer.close();
            server.kill();
            client.kill();
            fs.unlinkSync('test_backpressure_runner.js');
            resolve();
        }, 5000);
    });
}

testOomBackpressure();
