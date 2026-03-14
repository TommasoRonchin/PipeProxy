/**
 * Minimal stall diagnostic - NO encryption, monitors process-level I/O
 */
const http = require('http');
const crypto = require('crypto');
const path = require('path');
const { spawn } = require('child_process');
const { performance } = require('perf_hooks');

const TARGET_PORT = 9926;
const PROXY_PORT = 3926;
const TUNNEL_PORT = 8096;
const PAYLOAD_SIZE = 4 * 1024 * 1024;

async function testWithConfig(name, concurrent, encryption) {
    const payload = crypto.randomBytes(PAYLOAD_SIZE);
    const target = http.createServer((req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': payload.length });
        res.end(payload);
    });
    await new Promise(r => target.listen(TARGET_PORT, '127.0.0.1', r));

    const env = { ...process.env, PORT: PROXY_PORT, TUNNEL_PORT, TUNNEL_SECRET: 's', SKIP_DOTENV: 'true', BLOCK_LOCAL_NETWORK: 'false' };
    if (encryption) {
        env.ENCRYPTION_SECRET = 'a'.repeat(32);
        env.ENABLE_ENCRYPTION = 'true';
    }
    
    const proxy = spawn('node', [path.join(__dirname, '../server/proxyServer.js')], { env });
    const client = spawn('node', [path.join(__dirname, '../client/raspberryClient.js')], { env: { ...env, SERVER_URL: `ws://localhost:${TUNNEL_PORT}` } });

    proxy.stderr.on('data', d => {});
    client.stderr.on('data', d => {});
    proxy.stdout.on('data', d => {});
    client.stdout.on('data', d => {});

    await new Promise(r => setTimeout(r, 2000));

    let totalBytes = 0, ok = 0, fail = 0;
    const start = performance.now();
    let lastProgress = start;

    const download = () => new Promise(resolve => {
        let done = false;
        const finish = (err) => { if (done) return; done = true; clearTimeout(t); if (err) fail++; else ok++; resolve(); };
        const t = setTimeout(() => { req.destroy(); finish(true); }, 10000);
        const req = http.get({ host: '127.0.0.1', port: PROXY_PORT, path: `http://127.0.0.1:${TARGET_PORT}/data`, agent: false }, res => {
            let b = 0;
            res.on('data', c => { b += c.length; totalBytes += c.length; lastProgress = performance.now(); });
            res.on('end', () => finish(b === PAYLOAD_SIZE ? null : 'short'));
        });
        req.on('error', () => finish(true));
    });

    let stallDetected = false;
    const reporter = setInterval(() => {
        const elapsed = ((performance.now() - start) / 1000).toFixed(0);
        const stallSec = ((performance.now() - lastProgress) / 1000).toFixed(0);
        const mb = (totalBytes/1024/1024).toFixed(0);
        console.log(`  [${elapsed}s] ${mb} MB | OK: ${ok} | Fail: ${fail} | Stall: ${stallSec}s`);
        if (performance.now() - lastProgress > 8000 && ok > 10) {
            stallDetected = true;
        }
    }, 2000);

    // Run for 15s or until stall
    const worker = async () => {
        while (performance.now() - start < 15000 && !stallDetected) {
            await download();
            if (proxy.exitCode !== null) break;
        }
    };
    
    await Promise.all(Array.from({ length: concurrent }, () => worker()));
    clearInterval(reporter);

    const elapsed = ((performance.now() - start) / 1000).toFixed(1);
    const speed = (totalBytes / 1024 / 1024 / parseFloat(elapsed)).toFixed(1);
    console.log(`  => ${name}: ${(totalBytes/1024/1024).toFixed(0)} MB in ${elapsed}s (${speed} MB/s) | OK: ${ok} | Fail: ${fail} | Stall: ${stallDetected}`);
    
    proxy.kill(); client.kill(); target.close();
    await new Promise(r => setTimeout(r, 500));
    return { stallDetected, speed: parseFloat(speed), ok, fail };
}

async function main() {
    console.log('=== STALL DIAGNOSTIC ===\n');
    
    console.log('Test 1: 20 workers, NO encryption');
    const r1 = await testWithConfig('NoEncrypt-20w', 20, false);
    
    console.log('\nTest 2: 20 workers, WITH encryption');
    const r2 = await testWithConfig('Encrypt-20w', 20, true);
    
    console.log('\nTest 3: 5 workers, WITH encryption');
    const r3 = await testWithConfig('Encrypt-5w', 5, true);

    console.log('\n=== SUMMARY ===');
    console.log(`NoEncrypt-20w: stall=${r1.stallDetected}, ${r1.speed} MB/s`);
    console.log(`Encrypt-20w:   stall=${r2.stallDetected}, ${r2.speed} MB/s`);
    console.log(`Encrypt-5w:    stall=${r3.stallDetected}, ${r3.speed} MB/s`);
}
main();
