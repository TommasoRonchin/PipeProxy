const http = require('http');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');

// Fresh ports
const TARGET_PORT = 9970;
const PROXY_PORT = 3970;
const TUNNEL_PORT = 8097;

function startTargetServer() {
    const server = http.createServer((req, res) => {
        res.writeHead(200); res.end('OK');
    });
    return new Promise(r => server.listen(TARGET_PORT, '127.0.0.1', () => r(server)));
}

function spawnProcess(name, file, env) {
    const proc = spawn('node', [file], {
        env: { ...process.env, ...env, DEBUG: 'false', SKIP_DOTENV: 'true' }
    });
    proc.stderr.on('data', d => console.error(`[${name}] ${d.toString().trim()}`));
    return proc;
}

async function main() {
    console.log('--- TARGETED TEST: Connection ID 256 ---');
    const target = await startTargetServer();
    // Start at ID 250
    const proxy = spawnProcess('Proxy', path.join(__dirname, '../server/proxyServer.js'), {
        PORT: PROXY_PORT, TUNNEL_PORT: TUNNEL_PORT, TUNNEL_SECRET: 's', 
        ENCRYPTION_SECRET: 'a'.repeat(32), ENABLE_ENCRYPTION: 'true', DEBUG_START_ID: '250'
    });
    const client = spawnProcess('Client', path.join(__dirname, '../client/raspberryClient.js'), {
        SERVER_URL: `ws://localhost:${TUNNEL_PORT}`, TUNNEL_SECRET: 's', 
        ENCRYPTION_SECRET: 'a'.repeat(32), ENABLE_ENCRYPTION: 'true', BLOCK_LOCAL_NETWORK: 'false'
    });

    await new Promise(r => setTimeout(r, 2000));
    
    for (let i = 0; i < 20; i++) {
        const id = 250 + i;
        process.stdout.write(`Testing ID ${id}... `);
        await new Promise((resolve, reject) => {
            const req = http.get({
                host: '127.0.0.1', port: PROXY_PORT,
                path: `http://127.0.0.1:${TARGET_PORT}/`,
                agent: false
            }, res => {
                res.on('data', () => {});
                res.on('end', () => { console.log('OK'); resolve(); });
            });
            req.on('error', reject);
            setTimeout(() => { req.destroy(); reject(new Error('Timeout')); }, 2000);
        });
    }

    console.log('All tests passed! ID 256 is NOT a problem.');
    proxy.kill(); client.kill(); target.close();
}
main().catch(err => {
    console.error('\nFAILED:', err.message);
    process.exit(1);
});
