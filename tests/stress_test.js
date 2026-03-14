const http = require('http');
const net = require('net');
const { performance } = require('perf_hooks');
const crypto = require('crypto');
const path = require('path');
const { spawn } = require('child_process');

process.env.UV_THREADPOOL_SIZE = 128;

// Ports - FRESH SET
const TARGET_PORT = 9920;
const PROXY_PORT = 3920;
const TUNNEL_PORT = 8092;
const PAYLOAD_SIZE = 1 * 1024 * 1024; // 1MB
const CONCURRENT_REQUESTS = 30; 
const TOTAL_MB_TARGET = 1024; 

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
    return new Promise(r => server.listen(TARGET_PORT, '127.0.0.1', () => {
        console.log(`[TargetServer] Listening on ${TARGET_PORT}`);
        r(server);
    }));
}

function spawnProcess(name, file, env) {
    console.log(`[StressTest] Starting ${name}...`);
    const proc = spawn('node', [file], {
        env: { ...process.env, ...env, DEBUG: 'false', SKIP_DOTENV: 'true' }
    });
    proc.stderr.on('data', d => console.error(`[${name} ERR] ${d.toString().trim()}`));
    proc.on('exit', (c, s) => { if(c !== null) console.log(`[${name}] Exited with code ${c} signal ${s}`); });
    return proc;
}

async function runBenchmark(proxyProc, clientProc) {
    let totalDownloaded = 0;
    let completed = 0;
    let failed = 0;
    let active = 0;
    const startTime = performance.now();
    let lastTime = startTime, lastBytes = 0;

    const download = () => new Promise(resolve => {
        active++;
        let finished = false;
        const done = (err) => {
            if (finished) return;
            finished = true;
            active--;
            if (err) failed++;
            resolve();
        };

        const req = http.get({
            host: '127.0.0.1', port: PROXY_PORT,
            path: `http://127.0.0.1:${TARGET_PORT}/data`,
            agent: false, timeout: 5000
        }, res => {
            let bytes = 0;
            res.on('data', chunk => { bytes += chunk.length; totalDownloaded += chunk.length; });
            res.on('end', () => { 
                if (bytes === PAYLOAD_SIZE) completed++; else failed++;
                done();
            });
        });
        req.on('error', () => done(true));
        req.on('timeout', () => { req.destroy(); done(true); });
    });

    const reporter = setInterval(() => {
        const now = performance.now();
        const dt = (now - lastTime) / 1000;
        const totalElapsed = (now - startTime) / 1000;
        const speed = ((totalDownloaded - lastBytes) / 1024 / 1024 / dt).toFixed(2);
        const progress = (totalDownloaded / 1024 / 1024).toFixed(0);
        process.stdout.write(`\r[${totalElapsed.toFixed(0)}s] Progress: ${progress}/${TOTAL_MB_TARGET} MB | Inst: ${speed} MB/s | Active: ${active} | Fail: ${failed}    `);
        lastTime = now; lastBytes = totalDownloaded;
    }, 1000);

    const workerLoop = async () => {
        while ((totalDownloaded / 1024 / 1024) < TOTAL_MB_TARGET) {
            await download();
            if (proxyProc.exitCode !== null || clientProc.exitCode !== null) break;
            await new Promise(r => setImmediate(r));
        }
    };

    await Promise.all(Array.from({ length: CONCURRENT_REQUESTS }, () => workerLoop()));
    clearInterval(reporter);
    console.log('\nBenchmark Ended.');
    return { totalMB: totalDownloaded / 1024 / 1024, duration: (performance.now() - startTime) / 1000 };
}

async function main() {
    console.log('--- FINAL STRESS TEST (WITH ENCRYPTION) ---');
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
    const result = await runBenchmark(proxy, client);
    console.log(`Final Result: ${result.totalMB.toFixed(2)} MB in ${result.duration.toFixed(2)}s (${(result.totalMB / result.duration).toFixed(2)} MB/s)`);
    proxy.kill(); client.kill(); target.close();
}
main();
