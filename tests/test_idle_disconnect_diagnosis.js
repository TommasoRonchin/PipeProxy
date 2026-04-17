const net = require('net');
const path = require('path');
const assert = require('assert');
const { spawn } = require('child_process');

function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function waitForOutput(proc, pattern, timeoutMs = 10000) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            reject(new Error(`Timeout waiting for process output: ${pattern}`));
        }, timeoutMs);

        const onStdout = (chunk) => {
            if (pattern.test(chunk.toString())) {
                cleanup();
                resolve();
            }
        };

        const onExit = (code, signal) => {
            cleanup();
            reject(new Error(`Process exited early (code=${code}, signal=${signal}) while waiting for ${pattern}`));
        };

        function cleanup() {
            clearTimeout(timer);
            proc.stdout.removeListener('data', onStdout);
            proc.removeListener('exit', onExit);
        }

        proc.stdout.on('data', onStdout);
        proc.on('exit', onExit);
    });
}

async function startTunnelSystem(envOverrides = {}) {
    const env = {
        ...process.env,
        SKIP_DOTENV: 'true',
        PORT: envOverrides.PORT || '3190',
        TUNNEL_PORT: envOverrides.TUNNEL_PORT || '8190',
        SERVER_URL: `ws://127.0.0.1:${envOverrides.TUNNEL_PORT || '8190'}`,
        ENABLE_TLS_PROXY: 'false',
        ENABLE_PROXY_AUTH: 'false',
        BLOCK_LOCAL_NETWORK: 'false',
        TUNNEL_SECRET: 'idle_diag_secret',
        ENCRYPTION_SECRET: 'idle_diag_secret',
        ...envOverrides
    };

    const serverPath = path.join(__dirname, '..', 'server', 'proxyServer.js');
    const clientPath = path.join(__dirname, '..', 'client', 'raspberryClient.js');

    const serverProc = spawn('node', [serverPath], { env });
    const clientProc = spawn('node', [clientPath], { env });

    const serverLogs = [];

    serverProc.stdout.on('data', (d) => {
        const text = d.toString();
        serverLogs.push(text);
        for (const line of text.trim().split('\n')) {
            if (line) console.log('[SERVER]', line);
        }
    });
    serverProc.stderr.on('data', (d) => {
        const text = d.toString();
        serverLogs.push(text);
        for (const line of text.trim().split('\n')) {
            if (line) console.error('[SERVER_ERR]', line);
        }
    });

    clientProc.stdout.on('data', (d) => {
        for (const line of d.toString().trim().split('\n')) {
            if (line) console.log('[CLIENT]', line);
        }
    });
    clientProc.stderr.on('data', (d) => {
        for (const line of d.toString().trim().split('\n')) {
            if (line) console.error('[CLIENT_ERR]', line);
        }
    });

    await waitForOutput(serverProc, /Proxy is listening on port/);
    await waitForOutput(clientProc, /Connected to VPS Tunnel successfully/);

    return {
        env,
        serverProc,
        clientProc,
        serverLogs
    };
}

function stopProcess(proc) {
    if (!proc || proc.killed) return;
    proc.kill('SIGKILL');
}

function connectViaProxy({ proxyPort, targetPort }) {
    return new Promise((resolve, reject) => {
        const socket = net.connect(proxyPort, '127.0.0.1');

        let buffer = Buffer.alloc(0);
        let resolved = false;

        const failTimer = setTimeout(() => {
            if (resolved) return;
            resolved = true;
            socket.destroy();
            reject(new Error('Timeout establishing CONNECT tunnel through proxy'));
        }, 8000);

        socket.on('connect', () => {
            const req = `CONNECT 127.0.0.1:${targetPort} HTTP/1.1\r\nHost: 127.0.0.1:${targetPort}\r\n\r\n`;
            socket.write(req);
        });

        socket.on('data', (chunk) => {
            if (resolved) return;
            buffer = Buffer.concat([buffer, chunk]);
            const headerEnd = buffer.indexOf('\r\n\r\n');
            if (headerEnd === -1) return;

            resolved = true;
            clearTimeout(failTimer);

            const headerText = buffer.subarray(0, headerEnd).toString('utf8');
            if (!headerText.includes('200 Connection Established')) {
                socket.destroy();
                reject(new Error(`CONNECT failed: ${headerText.replace(/\r\n/g, ' | ')}`));
                return;
            }

            const leftover = buffer.subarray(headerEnd + 4);
            resolve({ socket, leftover });
        });

        socket.on('error', (err) => {
            if (resolved) return;
            resolved = true;
            clearTimeout(failTimer);
            reject(err);
        });
    });
}

async function waitForSocketClose(socket, timeoutMs = 10000) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            reject(new Error('Timeout waiting for socket close'));
        }, timeoutMs);

        const done = () => {
            clearTimeout(timer);
            resolve();
        };

        socket.once('close', done);
        socket.once('end', done);
    });
}

async function run() {
    console.log('=== Idle Disconnect Diagnosis Test ===');

    const idleTimeoutMs = process.env.TEST_IDLE_TIMEOUT_MS
        ? parseInt(process.env.TEST_IDLE_TIMEOUT_MS, 10)
        : 3000;
    const lowerBound = Math.max(1000, idleTimeoutMs - 700);
    const upperBound = idleTimeoutMs + 3000;
    const closeWaitTimeoutMs = idleTimeoutMs + 10000;

    let sys;
    let targetServer;
    try {
        sys = await startTunnelSystem({
            PORT: '3190',
            TUNNEL_PORT: '8190',
            IDLE_TIMEOUT_MS: String(idleTimeoutMs),
            PING_INTERVAL_MS: '30000'
        });

        targetServer = net.createServer((socket) => {
            socket.on('data', (d) => {
                socket.write(Buffer.from(`ECHO:${d.toString()}`));
            });
        });

        await new Promise((resolve) => targetServer.listen(4091, '127.0.0.1', resolve));

        console.log(`Test 1: idle CONNECT tunnel should close around IDLE_TIMEOUT_MS=${idleTimeoutMs}`);
        const tunnel1 = await connectViaProxy({ proxyPort: 3190, targetPort: 4091 });
        if (tunnel1.leftover.length > 0) {
            console.log(`[INFO] Leftover bytes after CONNECT: ${tunnel1.leftover.length}`);
        }

        const t0 = Date.now();
        await waitForSocketClose(tunnel1.socket, closeWaitTimeoutMs);
        const elapsed = Date.now() - t0;
        console.log(`[RESULT] Idle tunnel closed after ${elapsed}ms`);

        assert(elapsed >= lowerBound && elapsed <= upperBound,
            `Expected idle close ~${idleTimeoutMs}ms (tolerance ${lowerBound}-${upperBound}), got ${elapsed}ms`);

        console.log('Test 2: periodic traffic should keep tunnel alive past idle timeout');
        const tunnel2 = await connectViaProxy({ proxyPort: 3190, targetPort: 4091 });
        let gotEcho = false;

        tunnel2.socket.on('data', (chunk) => {
            if (chunk.toString().includes('ECHO:')) gotEcho = true;
        });

        let closedEarly = false;
        tunnel2.socket.once('close', () => {
            closedEarly = true;
        });

        const keepAliveInterval = setInterval(() => {
            if (!tunnel2.socket.destroyed) {
                tunnel2.socket.write('k');
            }
        }, 1000);

        const keepAliveWindowMs = Math.max(6500, idleTimeoutMs + 1500);
        await delay(keepAliveWindowMs);
        clearInterval(keepAliveInterval);

        assert(!closedEarly, 'Socket closed despite periodic traffic');
        assert(gotEcho, 'Expected echo traffic while keepalive bytes were sent');

        const t1 = Date.now();
        await waitForSocketClose(tunnel2.socket, closeWaitTimeoutMs);
        const elapsedAfterStop = Date.now() - t1;
        console.log(`[RESULT] After stopping traffic, tunnel closed after ${elapsedAfterStop}ms`);
        assert(elapsedAfterStop >= lowerBound && elapsedAfterStop <= upperBound,
            `Expected close ~${idleTimeoutMs}ms after traffic stops, got ${elapsedAfterStop}ms`);

        const combinedLogs = sys.serverLogs.join('');
        assert(combinedLogs.includes('Connection idle timeout reached, closing socket'),
            'Expected server idle-timeout log not found');

        console.log('PASS: disconnections are explained by proxy idle timeout, not 30s heartbeat in this setup.');
        process.exitCode = 0;
    } catch (err) {
        console.error('FAIL:', err.message);
        process.exitCode = 1;
    } finally {
        if (targetServer) {
            await new Promise((resolve) => targetServer.close(resolve));
        }
        if (sys) {
            stopProcess(sys.serverProc);
            stopProcess(sys.clientProc);
        }
        await delay(200);
    }
}

run();
