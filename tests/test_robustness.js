const { spawn } = require('child_process');
const net = require('net');
const path = require('path');

async function delay(ms) {
    return new Promise(r => setTimeout(r, ms));
}

async function testTlsFailure() {
    console.log('--- Testing TLS Initialization Failure ---');
    const env = {
        ...process.env,
        ENABLE_TLS_PROXY: 'true',
        TLS_CERT_PATH: 'non_existent_cert.pem',
        TLS_KEY_PATH: 'non_existent_key.pem',
        PORT: 3129,
        SKIP_DOTENV: 'true'
    };

    const server = spawn('node', [path.join(__dirname, 'server', 'proxyServer.js')], { env });
    let output = '';
    server.stdout.on('data', d => output += d.toString());
    server.stderr.on('data', d => output += d.toString());

    return new Promise((resolve) => {
        let resolved = false;
        server.on('exit', (code) => {
            if (resolved) return;
            resolved = true;
            if (code === 1 && output.includes('Exiting because ENABLE_TLS_PROXY is set')) {
                console.log('✅ Server exited correctly on TLS failure.');
            } else {
                console.error('❌ Server did not exit correctly on TLS failure.');
                console.error('Exit Code:', code);
                console.error('Full Server Output:\n', output);
            }
            resolve();
        });
        setTimeout(() => {
            if (resolved) return;
            resolved = true;
            console.error('❌ Server timed out and did not exit on TLS failure.');
            console.error('Current Server Output:\n', output);
            server.kill('SIGKILL');
            resolve();
        }, 5000);
    });
}

async function testMalformedHeader() {
    console.log('\n--- Testing Malformed Header Handling ---');
    const env = { ...process.env, PORT: 3130, SKIP_DOTENV: 'true', ENABLE_TLS_PROXY: 'false' };
    const server = spawn('node', [path.join(__dirname, 'server', 'proxyServer.js')], { env });

    let serverOutput = '';
    server.stdout.on('data', d => serverOutput += d.toString());
    server.stderr.on('data', d => serverOutput += d.toString());

    await delay(2000);

    const client = net.connect(3130, '127.0.0.1', () => {
        client.write('malformed-request-without-spaces\r\n\r\n');
    });

    let dataReceived = '';
    let closed = false;

    client.on('data', d => {
        dataReceived += d.toString();
    });

    client.on('error', (err) => {
        // console.log('[Client Error]', err.code);
    });

    return new Promise((resolve) => {
        client.on('close', () => {
            closed = true;
            if (dataReceived.includes('400 Bad Request')) {
                console.log('✅ Malformed header handled with 400 Bad Request.');
            } else {
                console.error('❌ Malformed header did not return 400. Received:', dataReceived);
                console.error('Server Output during this test:\n', serverOutput);
            }
            console.log('✅ Socket closed correctly.');
            server.kill();
            resolve();
        });

        setTimeout(() => {
            if (!closed) {
                console.error('❌ Socket did not close after malformed header.');
                console.error('Data received before timeout:', dataReceived);
                console.error('Server Output before timeout:\n', serverOutput);
                client.destroy();
                server.kill();
                resolve();
            }
        }, 5000);
    });
}

async function runTests() {
    await testTlsFailure();
    await testMalformedHeader();
}

runTests();
