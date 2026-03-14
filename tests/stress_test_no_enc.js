const http = require('http');
const net = require('net');
const { performance } = require('perf_hooks');
const crypto = require('crypto');
const path = require('path');
const { spawn } = require('child_process');

process.env.UV_THREADPOOL_SIZE = 128;

// Ports - FRESH SET
const TARGET_PORT = 9921; // Changed ports to avoid conflict if run together
const PROXY_PORT = 3921;
const TUNNEL_PORT = 8093;
const PAYLOAD_SIZE = 4 * 1024 * 1024; // 4MB per request
const CONCURRENT_REQUESTS = 20;
const TOTAL_MB_TARGET = 10240; // 10GB
const REQUEST_TIMEOUT_MS = 30000; // 30s idle timeout per request
const STALL_DETECT_MS = 20000; // 20s without progress = stall detected

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
    let timedOut = 0;
    const startTime = performance.now();
    let lastTime = startTime, lastBytes = 0;
    let lastProgressTime = performance.now(); // for stall detection
    let lastProgressBytes = 0;
    let minInstSpeed = Infinity, maxInstSpeed = 0;
    const activeRequests = new Set(); // track active requests for stall recovery

    const download = () => new Promise(resolve => {
        active++;
        let finished = false;
        const done = (err) => {
            if (finished) return;
            finished = true;
            active--;
            activeRequests.delete(req);
            clearTimeout(hardTimeout);
            if (err) {
                failed++;
                if (err === 'timeout') timedOut++;
            }
            resolve();
        };

        const hardTimeout = setTimeout(() => {
            if (!finished) {
                req.destroy();
                done('timeout');
            }
        }, REQUEST_TIMEOUT_MS);

        const req = http.get({
            host: '127.0.0.1', port: PROXY_PORT,
            path: `http://127.0.0.1:${TARGET_PORT}/data`,
            agent: false, timeout: REQUEST_TIMEOUT_MS
        }, res => {
            let bytes = 0;
            res.on('data', chunk => {
                bytes += chunk.length;
                totalDownloaded += chunk.length;
                if (totalDownloaded > lastProgressBytes) {
                    lastProgressTime = performance.now();
                    lastProgressBytes = totalDownloaded;
                }
            });
            res.on('end', () => { 
                if (bytes === PAYLOAD_SIZE) completed++; else failed++;
                done();
            });
        });
        activeRequests.add(req);
        req.on('error', () => done(true));
        req.on('timeout', () => { req.destroy(); done('timeout'); });
    });

    const reporter = setInterval(() => {
        const now = performance.now();
        const dt = (now - lastTime) / 1000;
        const totalElapsed = (now - startTime) / 1000;
        const instSpeed = ((totalDownloaded - lastBytes) / 1024 / 1024 / dt);
        const avgSpeed = (totalDownloaded / 1024 / 1024 / totalElapsed);
        const progress = (totalDownloaded / 1024 / 1024).toFixed(0);

        if (instSpeed > 0 && isFinite(instSpeed)) {
            if (instSpeed < minInstSpeed) minInstSpeed = instSpeed;
            if (instSpeed > maxInstSpeed) maxInstSpeed = instSpeed;
        }

        const stallSec = ((now - lastProgressTime) / 1000).toFixed(0);
        process.stdout.write(`\r[${totalElapsed.toFixed(0)}s] ${progress}/${TOTAL_MB_TARGET} MB | Inst: ${instSpeed.toFixed(2)} MB/s | Avg: ${avgSpeed.toFixed(2)} MB/s | Active: ${active} | OK: ${completed} | Fail: ${failed} | TO: ${timedOut} | Stall: ${stallSec}s    `);
        lastTime = now; lastBytes = totalDownloaded;
    }, 1000);

    const workerLoop = async () => {
        while ((totalDownloaded / 1024 / 1024) < TOTAL_MB_TARGET) {
            const stallTime = performance.now() - lastProgressTime;
            if (stallTime > STALL_DETECT_MS && active > 0) {
                console.log(`\n[StressTest] STALL DETECTED: No progress for ${(stallTime/1000).toFixed(0)}s. Aborting ${activeRequests.size} stuck requests...`);
                for (const req of activeRequests) {
                    try { req.destroy(); } catch {}
                }
                await new Promise(r => setTimeout(r, 1000));
                lastProgressTime = performance.now();
            }

            await download();
            if (proxyProc.exitCode !== null || clientProc.exitCode !== null) break;
            await new Promise(r => setImmediate(r));
        }
    };

    await Promise.all(Array.from({ length: CONCURRENT_REQUESTS }, () => workerLoop()));
    clearInterval(reporter);

    const totalElapsed = (performance.now() - startTime) / 1000;
    const avgSpeed = (totalDownloaded / 1024 / 1024 / totalElapsed);

    console.log('\n\n' + '='.repeat(60));
    console.log('📊 STRESS TEST RESULTS (NO ENCRYPTION)');
    console.log('='.repeat(60));
    console.log(`Total Transferred:   ${(totalDownloaded / 1024 / 1024).toFixed(2)} MB / ${TOTAL_MB_TARGET} MB`);
    console.log(`Total Duration:      ${totalElapsed.toFixed(2)} s`);
    console.log(`Average Speed:       ${avgSpeed.toFixed(2)} MB/s`);
    console.log(`Min Instant Speed:   ${minInstSpeed === Infinity ? 'N/A' : minInstSpeed.toFixed(2)} MB/s`);
    console.log(`Max Instant Speed:   ${maxInstSpeed.toFixed(2)} MB/s`);
    console.log(`Completed Requests:  ${completed}`);
    console.log(`Failed Requests:     ${failed}`);
    console.log(`Timed Out:           ${timedOut}`);
    console.log(`Concurrent Workers:  ${CONCURRENT_REQUESTS}`);
    console.log(`Payload Size:        ${PAYLOAD_SIZE / 1024 / 1024} MB`);
    console.log('='.repeat(60));

    return { totalMB: totalDownloaded / 1024 / 1024, duration: totalElapsed };
}

async function main() {
    console.log('='.repeat(60));
    console.log('⚡ 10GB STRESS TEST (WITHOUT ENCRYPTION) ⚡');
    console.log('='.repeat(60));
    console.log(`Config: ${TOTAL_MB_TARGET} MB target | ${PAYLOAD_SIZE / 1024 / 1024} MB chunks | ${CONCURRENT_REQUESTS} workers | ${REQUEST_TIMEOUT_MS/1000}s timeout\n`);

    const target = await startTargetServer();
    const proxy = spawnProcess('Proxy', path.join(__dirname, '../server/proxyServer.js'), {
        PORT: PROXY_PORT, TUNNEL_PORT: TUNNEL_PORT, TUNNEL_SECRET: 's', 
        ENABLE_ENCRYPTION: 'false'
    });
    const client = spawnProcess('Client', path.join(__dirname, '../client/raspberryClient.js'), {
        SERVER_URL: `ws://localhost:${TUNNEL_PORT}`, TUNNEL_SECRET: 's', 
        ENABLE_ENCRYPTION: 'false', BLOCK_LOCAL_NETWORK: 'false'
    });

    await new Promise(r => setTimeout(r, 2000));
    const result = await runBenchmark(proxy, client);
    console.log(`\nFinal: ${result.totalMB.toFixed(2)} MB in ${result.duration.toFixed(2)}s (${(result.totalMB / result.duration).toFixed(2)} MB/s AVG)`);
    proxy.kill(); client.kill(); target.close();
}
main();
