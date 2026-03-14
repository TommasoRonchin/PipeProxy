const http = require('http');
const net = require('net');
const { performance } = require('perf_hooks');
const crypto = require('crypto');
const path = require('path');
const { spawn } = require('child_process');

process.env.UV_THREADPOOL_SIZE = 64;

// Use fresh ports to avoid EADDRINUSE
const TARGET_PORT = 9950;
const PROXY_PORT = 3950;
const TUNNEL_PORT = 8095;
const PAYLOAD_SIZE = 1 * 1024 * 1024; // 1MB
const CONCURRENT_REQUESTS = 1; // Testing the "256 connections" theory
const TOTAL_MB_TARGET = 512; 

function startTargetServer() {
    const payload = crypto.randomBytes(PAYLOAD_SIZE);
    const server = http.createServer((req, res) => {
        if (req.url === '/data') {
            res.writeHead(200, {
                'Content-Type': 'application/octet-stream',
                'Content-Length': payload.length
            });
            res.end(payload);
        } else {
            res.writeHead(404); res.end();
        }
    });
    return new Promise(r => server.listen(TARGET_PORT, '127.0.0.1', () => r(server)));
}

function spawnProcess(name, file, env) {
    const proc = spawn('node', [file], {
        env: { ...process.env, ...env, DEBUG: 'false', SKIP_DOTENV: 'true' }
    });
    return proc;
}

async function runBenchmark(proxyProc, clientProc) {
    let totalDownloaded = 0;
    let completed = 0;
    let failed = 0;
    const startTime = performance.now();

    const download = () => new Promise(resolve => {
        const req = http.get({
            host: '127.0.0.1', port: PROXY_PORT,
            path: `http://127.0.0.1:${TARGET_PORT}/data`,
            agent: false, timeout: 5000
        }, res => {
            let bytes = 0;
            res.on('data', chunk => { totalDownloaded += chunk.length; bytes += chunk.length; });
            res.on('end', () => { if (bytes === PAYLOAD_SIZE) completed++; else failed++; resolve(); });
        });
        req.on('error', () => { failed++; resolve(); });
        req.on('timeout', () => { req.destroy(); failed++; resolve(); });
    });

    const reporter = setInterval(() => {
        const progress = (totalDownloaded / 1024 / 1024).toFixed(0);
        process.stdout.write(`\rProgress: ${progress}/${TOTAL_MB_TARGET} MB | Req: ${completed}/${progress} | Fail: ${failed}    `);
    }, 500);

    for (let i = 0; i < TOTAL_MB_TARGET; i++) {
        await download();
        if (proxyProc.exitCode !== null || clientProc.exitCode !== null) break;
    }

    clearInterval(reporter);
    console.log('\nBenchmark Ended.');
}

async function main() {
    console.log('--- CONNECTION ID LIMIT TEST (256?) ---');
    const target = await startTargetServer();
    const proxy = spawnProcess('Proxy', path.join(__dirname, '../server/proxyServer.js'), {
        PORT: PROXY_PORT, TUNNEL_PORT: TUNNEL_PORT, TUNNEL_SECRET: 's', 
        ENCRYPTION_SECRET: 'a'.repeat(32), ENABLE_ENCRYPTION: 'true'
    });
    const client = spawnProcess('Client', path.join(__dirname, '../client/raspberryClient.js'), {
        SERVER_URL: `ws://localhost:${TUNNEL_PORT}`, TUNNEL_SECRET: 's', 
        ENCRYPTION_SECRET: 'a'.repeat(32), ENABLE_ENCRYPTION: 'true', BLOCK_LOCAL_NETWORK: 'false'
    });

    await new Promise(r => setTimeout(r, 2000));
    await runBenchmark(proxy, client);
    proxy.kill(); client.kill(); target.close();
}
main();
