const http = require('http');
const net = require('net');
const { performance } = require('perf_hooks');
const crypto = require('crypto');
const path = require('path');
const { spawn } = require('child_process');

process.env.UV_THREADPOOL_SIZE = 64;

// Fresh ports
const TARGET_PORT = 9960;
const PROXY_PORT = 3960;
const TUNNEL_PORT = 8096;
const PAYLOAD_SIZE = 1 * 1024 * 1024;
const CONCURRENT_REQUESTS = 1;
const TOTAL_MB_TARGET = 300; // Just enough to hit 256

function startTargetServer() {
    const payload = crypto.randomBytes(PAYLOAD_SIZE);
    const server = http.createServer((req, res) => {
        if (req.url === '/data') {
            res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': payload.length });
            res.end(payload);
        } else { res.writeHead(404); res.end(); }
    });
    return new Promise(r => server.listen(TARGET_PORT, '127.0.0.1', () => r(server)));
}

function spawnProcess(name, file, env) {
    const proc = spawn('node', [file], {
        env: { ...process.env, ...env, DEBUG: 'true', SKIP_DOTENV: 'true' }
    });
    proc.stdout.on('data', d => console.log(`[${name}] ${d.toString().trim()}`));
    proc.stderr.on('data', d => console.error(`[${name} ERR] ${d.toString().trim()}`));
    return proc;
}

async function runBenchmark(proxyProc, clientProc) {
    let totalDownloaded = 0;
    let completed = 0;
    const startTime = performance.now();

    const download = (id) => new Promise(resolve => {
        const req = http.get({
            host: '127.0.0.1', port: PROXY_PORT,
            path: `http://127.0.0.1:${TARGET_PORT}/data`,
            agent: false, timeout: 5000
        }, res => {
            let bytes = 0;
            res.on('data', chunk => { totalDownloaded += chunk.length; bytes += chunk.length; });
            res.on('end', () => { 
                if (bytes === PAYLOAD_SIZE) completed++; 
                resolve(); 
            });
        });
        req.on('error', () => resolve());
    });

    for (let i = 0; i < TOTAL_MB_TARGET; i++) {
        process.stdout.write(`\rConnection #${i+1}... `);
        await download(i+1);
        if (proxyProc.exitCode !== null || clientProc.exitCode !== null) {
             console.log('\nProcess exited!');
             break;
        }
    }
}

async function main() {
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
