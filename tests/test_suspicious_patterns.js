const net = require('net');
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');

const PROXY_PORT = 3181;
const TUNNEL_PORT = 8181;
const TARGET_PORT = 4181;

function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseHttpResponse(buffer) {
    const text = buffer.toString('utf8');
    const firstLineEnd = text.indexOf('\r\n');
    const statusLine = firstLineEnd >= 0 ? text.substring(0, firstLineEnd) : text;
    const statusMatch = statusLine.match(/HTTP\/1\.[01]\s+(\d{3})/);
    const statusCode = statusMatch ? parseInt(statusMatch[1], 10) : 0;

    const headerEnd = text.indexOf('\r\n\r\n');
    const body = headerEnd >= 0 ? text.substring(headerEnd + 4) : '';

    return { statusCode, statusLine, body, raw: text };
}

function extractJsonBody(responseBody) {
    const start = responseBody.indexOf('{');
    const end = responseBody.lastIndexOf('}');
    if (start === -1 || end === -1 || end <= start) return null;
    try {
        return JSON.parse(responseBody.substring(start, end + 1));
    } catch {
        return null;
    }
}

function sendRawProxyRequest(rawRequest, timeoutMs = 6000) {
    return new Promise((resolve, reject) => {
        const socket = net.connect(PROXY_PORT, '127.0.0.1', () => {
            socket.write(rawRequest);
        });

        const chunks = [];
        socket.on('data', (d) => chunks.push(d));
        socket.on('error', (err) => reject(err));
        socket.on('close', () => resolve(parseHttpResponse(Buffer.concat(chunks))));

        setTimeout(() => {
            if (!socket.destroyed) socket.destroy();
        }, timeoutMs);
    });
}

async function waitForTunnelReady(reqBase, timeoutMs = 12000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        try {
            const res = await sendRawProxyRequest(
                `GET ${reqBase}/warmup HTTP/1.1\r\nHost: 127.0.0.1:${TARGET_PORT}\r\n\r\n`,
                2500
            );
            if (res.statusCode === 200) return true;
        } catch {
            // keep retrying until timeout
        }
        await delay(250);
    }
    return false;
}

async function main() {
    const targetServer = http.createServer((req, res) => {
        const bodyChunks = [];
        req.on('data', (c) => bodyChunks.push(c));
        req.on('end', () => {
            const body = Buffer.concat(bodyChunks).toString('utf8');
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                method: req.method,
                url: req.url,
                headers: req.headers,
                body
            }));
        });
    });

    await new Promise((resolve) => targetServer.listen(TARGET_PORT, '127.0.0.1', resolve));

    const baseEnv = {
        ...process.env,
        SKIP_DOTENV: 'true',
        PORT: String(PROXY_PORT),
        TUNNEL_PORT: String(TUNNEL_PORT),
        TUNNEL_SECRET: 'suspicious_test_secret',
        SERVER_URL: `ws://127.0.0.1:${TUNNEL_PORT}`,
        ENABLE_TLS_PROXY: 'false',
        BLOCK_LOCAL_NETWORK: 'false',
        FORCE_CONNECTION_CLOSE: 'false',
        SMART_HTTP_CLOSE: 'true',
        STRICT_HTTP_FRAMING: 'true',
        ENABLE_ENCRYPTION: 'true',
        ENCRYPTION_SECRET: 'a'.repeat(32)
    };

    const proxyProc = spawn('node', [path.join(__dirname, '..', 'server', 'proxyServer.js')], { env: baseEnv });
    const clientProc = spawn('node', [path.join(__dirname, '..', 'client', 'raspberryClient.js')], { env: baseEnv });

    proxyProc.stderr.on('data', (d) => process.stderr.write(`[PROXY ERR] ${d.toString()}`));
    clientProc.stderr.on('data', (d) => process.stderr.write(`[CLIENT ERR] ${d.toString()}`));

    let passed = 0;
    let failed = 0;

    function assert(condition, name, details) {
        if (condition) {
            console.log(`  PASS ${name}`);
            passed++;
        } else {
            console.error(`  FAIL ${name}${details ? ` -> ${details}` : ''}`);
            failed++;
        }
    }

    console.log('=== Suspicious Pattern Recognition Suite ===');

    const reqBase = `http://127.0.0.1:${TARGET_PORT}`;

    const ready = await waitForTunnelReady(reqBase);
    if (!ready) {
        console.error('Tunnel readiness check failed before running suspicious-pattern suite.');
        if (!proxyProc.killed) proxyProc.kill('SIGKILL');
        if (!clientProc.killed) clientProc.kill('SIGKILL');
        await delay(300);
        await new Promise((resolve) => targetServer.close(resolve));
        process.exit(1);
    }

    const r1 = await sendRawProxyRequest(
        `GET ${reqBase}/safe HTTP/1.1\r\nHost: 127.0.0.1:${TARGET_PORT}\r\n\r\n`
    );
    assert(r1.statusCode === 200, 'baseline-safe-get', r1.statusLine);

    const r2 = await sendRawProxyRequest(
        `GET ${reqBase}/dup-cl-eq HTTP/1.1\r\nHost: 127.0.0.1:${TARGET_PORT}\r\nContent-Length: 0\r\nContent-Length: 0\r\n\r\n`
    );
    assert(r2.statusCode === 400, 'duplicate-cl-equal-rejected-in-strict-mode', r2.statusLine);

    const r3 = await sendRawProxyRequest(
        `GET ${reqBase}/dup-cl-conflict HTTP/1.1\r\nHost: 127.0.0.1:${TARGET_PORT}\r\nContent-Length: 0\r\nContent-Length: 1\r\n\r\n`
    );
    assert(r3.statusCode === 400, 'duplicate-cl-conflict-rejected', r3.statusLine);

    const r4 = await sendRawProxyRequest(
        `POST ${reqBase}/invalid-cl HTTP/1.1\r\nHost: 127.0.0.1:${TARGET_PORT}\r\nContent-Length: 5x\r\n\r\nhello`
    );
    assert(r4.statusCode === 400, 'invalid-cl-nonnumeric-rejected', r4.statusLine);

    const r5 = await sendRawProxyRequest(
        `GET ${reqBase}/malformed-header HTTP/1.1\r\nHost: 127.0.0.1:${TARGET_PORT}\r\nBadHeaderWithoutColon\r\n\r\n`
    );
    assert(r5.statusCode === 400, 'malformed-header-line-rejected', r5.statusLine);

    const r6 = await sendRawProxyRequest(
        `GET ${reqBase}/empty-header-name HTTP/1.1\r\nHost: 127.0.0.1:${TARGET_PORT}\r\n: value\r\n\r\n`
    );
    assert(r6.statusCode === 400, 'empty-header-name-rejected', r6.statusLine);

    const r7 = await sendRawProxyRequest(
        `GET ${reqBase}/host-conflict HTTP/1.1\r\nHost: 127.0.0.1:${TARGET_PORT}\r\nHost: evil.local\r\n\r\n`
    );
    assert(r7.statusCode === 400, 'conflicting-host-rejected', r7.statusLine);

    const r8 = await sendRawProxyRequest(
        `POST ${reqBase}/te-cl HTTP/1.1\r\nHost: 127.0.0.1:${TARGET_PORT}\r\nTransfer-Encoding: chunked\r\nContent-Length: 5\r\n\r\n0\r\n\r\n`
    );
    assert(r8.statusCode === 400, 'te-cl-conflict-rejected', r8.statusLine);

    const r9 = await sendRawProxyRequest(
        `POST ${reqBase}/te-unsupported HTTP/1.1\r\nHost: 127.0.0.1:${TARGET_PORT}\r\nTransfer-Encoding: gzip\r\n\r\n`
    );
    assert(r9.statusCode === 400, 'te-unsupported-rejected', r9.statusLine);

    const r10 = await sendRawProxyRequest(
        `POST ${reqBase}/te-nonfinal-chunked HTTP/1.1\r\nHost: 127.0.0.1:${TARGET_PORT}\r\nTransfer-Encoding: chunked, gzip\r\n\r\n`
    );
    assert(r10.statusCode === 400, 'te-nonfinal-chunked-rejected', r10.statusLine);

    const r11 = await sendRawProxyRequest(
        `POST ${reqBase}/te-empty HTTP/1.1\r\nHost: 127.0.0.1:${TARGET_PORT}\r\nTransfer-Encoding:\r\n\r\n`
    );
    assert(r11.statusCode === 400, 'te-empty-rejected', r11.statusLine);

    const r12 = await sendRawProxyRequest(
        `POST ${reqBase}/chunked-ok HTTP/1.1\r\nHost: 127.0.0.1:${TARGET_PORT}\r\nTransfer-Encoding: chunked\r\n\r\n4\r\nWiki\r\n0\r\n\r\n`
    );
    const j12 = extractJsonBody(r12.body);
    assert(r12.statusCode === 200 && j12 && j12.body === 'Wiki', 'valid-chunked-forwarded', r12.statusLine);

    const r13 = await sendRawProxyRequest(
        `POST ${reqBase}/post-close HTTP/1.1\r\nHost: 127.0.0.1:${TARGET_PORT}\r\nContent-Length: 4\r\n\r\ntest`
    );
    const j13 = extractJsonBody(r13.body);
    assert(r13.statusCode === 200 && j13 && j13.headers && j13.headers.connection === 'close', 'post-with-body-forced-close', j13 ? JSON.stringify(j13.headers) : r13.statusLine);

    const r14 = await sendRawProxyRequest(
        `GET ${reqBase}/get-keepalive HTTP/1.1\r\nHost: 127.0.0.1:${TARGET_PORT}\r\n\r\n`
    );
    const j14 = extractJsonBody(r14.body);
    assert(r14.statusCode === 200 && j14 && j14.headers && j14.headers.connection !== 'close', 'safe-get-kept-alive', j14 ? JSON.stringify(j14.headers) : r14.statusLine);

    const r15 = await sendRawProxyRequest(
        `GET ${reqBase}/connection-te-hint HTTP/1.1\r\nHost: 127.0.0.1:${TARGET_PORT}\r\nConnection: keep-alive, transfer-encoding\r\n\r\n`
    );
    const j15 = extractJsonBody(r15.body);
    assert(r15.statusCode === 200 && j15 && j15.headers && j15.headers.connection === 'close', 'connection-te-hint-isolated-with-close', j15 ? JSON.stringify(j15.headers) : r15.statusLine);

    const r16 = await sendRawProxyRequest(
        `GET ${reqBase}/obs-fold HTTP/1.1\r\nHost: 127.0.0.1:${TARGET_PORT}\r\nX-Test: one\r\n\tcontinued\r\n\r\n`
    );
    assert(r16.statusCode === 400, 'obs-fold-rejected', r16.statusLine);

    const r17 = await sendRawProxyRequest(
        `GET ${reqBase}/pipeline-safe HTTP/1.1\r\nHost: 127.0.0.1:${TARGET_PORT}\r\n\r\nGET ${reqBase}/pipeline-safe-2 HTTP/1.1\r\nHost: 127.0.0.1:${TARGET_PORT}\r\n\r\n`
    );
    assert(r17.raw.includes('/pipeline-safe') && r17.raw.includes('/pipeline-safe-2'), 'http-pipelining-still-works', r17.statusLine);

    const extraCases = [
        {
            name: 'duplicate-host-same-value-rejected-in-strict-mode',
            raw: `GET ${reqBase}/dup-host-same HTTP/1.1\r\nHost: 127.0.0.1:${TARGET_PORT}\r\nHost: 127.0.0.1:${TARGET_PORT}\r\n\r\n`,
            expectStatus: 400
        },
        {
            name: 'duplicate-te-header-rejected',
            raw: `POST ${reqBase}/dup-te HTTP/1.1\r\nHost: 127.0.0.1:${TARGET_PORT}\r\nTransfer-Encoding: gzip\r\nTransfer-Encoding: chunked\r\n\r\n`,
            expectStatus: 400
        },
        {
            name: 'repeated-chunked-token-rejected',
            raw: `POST ${reqBase}/repeat-chunked HTTP/1.1\r\nHost: 127.0.0.1:${TARGET_PORT}\r\nTransfer-Encoding: chunked, chunked\r\n\r\n`,
            expectStatus: 400
        },
        {
            name: 'invalid-te-token-rejected',
            raw: `POST ${reqBase}/invalid-te-token HTTP/1.1\r\nHost: 127.0.0.1:${TARGET_PORT}\r\nTransfer-Encoding: chunked,@bad\r\n\r\n`,
            expectStatus: 400
        },
        {
            name: 'uppercase-chunked-accepted',
            raw: `POST ${reqBase}/uppercase-chunked HTTP/1.1\r\nHost: 127.0.0.1:${TARGET_PORT}\r\nTransfer-Encoding: CHUNKED\r\n\r\n5\r\nHello\r\n0\r\n\r\n`,
            expectStatus: 200,
            bodyIncludes: 'Hello'
        },
        {
            name: 'chunked-with-extension-accepted',
            raw: `POST ${reqBase}/chunk-ext HTTP/1.1\r\nHost: 127.0.0.1:${TARGET_PORT}\r\nTransfer-Encoding: chunked\r\n\r\n4;foo=bar\r\nWiki\r\n0\r\n\r\n`,
            expectStatus: 200,
            bodyIncludes: 'Wiki'
        },
        {
            name: 'cl-plus-prefix-rejected',
            raw: `POST ${reqBase}/cl-plus HTTP/1.1\r\nHost: 127.0.0.1:${TARGET_PORT}\r\nContent-Length: +5\r\n\r\nhello`,
            expectStatus: 400
        },
        {
            name: 'cl-negative-rejected',
            raw: `POST ${reqBase}/cl-negative HTTP/1.1\r\nHost: 127.0.0.1:${TARGET_PORT}\r\nContent-Length: -1\r\n\r\n`,
            expectStatus: 400
        },
        {
            name: 'cl-leading-zeros-accepted',
            raw: `POST ${reqBase}/cl-leading-zeros HTTP/1.1\r\nHost: 127.0.0.1:${TARGET_PORT}\r\nContent-Length: 0004\r\n\r\ntest`,
            expectStatus: 200,
            bodyIncludes: 'test'
        },
        {
            name: 'request-line-lowercase-method-rejected',
            raw: `get ${reqBase}/lowercase HTTP/1.1\r\nHost: 127.0.0.1:${TARGET_PORT}\r\n\r\n`,
            expectStatus: 400
        },
        {
            name: 'request-line-missing-http-version-rejected',
            raw: `GET ${reqBase}/missing-version\r\nHost: 127.0.0.1:${TARGET_PORT}\r\n\r\n`,
            expectStatus: 400
        },
        {
            name: 'invalid-absolute-url-rejected',
            raw: `GET http://:bad HTTP/1.1\r\nHost: example.com\r\n\r\n`,
            expectStatus: 400
        },
        {
            name: 'head-kept-alive',
            raw: `HEAD ${reqBase}/head-safe HTTP/1.1\r\nHost: 127.0.0.1:${TARGET_PORT}\r\n\r\n`,
            expectStatus: 200
        },
        {
            name: 'options-kept-alive',
            raw: `OPTIONS ${reqBase}/opt-safe HTTP/1.1\r\nHost: 127.0.0.1:${TARGET_PORT}\r\n\r\n`,
            expectStatus: 200,
            expectConnectionNotClose: true
        },
        {
            name: 'put-forced-close',
            raw: `PUT ${reqBase}/put-close HTTP/1.1\r\nHost: 127.0.0.1:${TARGET_PORT}\r\nContent-Length: 4\r\n\r\nbody`,
            expectStatus: 200,
            expectConnectionClose: true
        },
        {
            name: 'delete-forced-close',
            raw: `DELETE ${reqBase}/delete-close HTTP/1.1\r\nHost: 127.0.0.1:${TARGET_PORT}\r\n\r\n`,
            expectStatus: 200,
            expectConnectionClose: true
        },
        {
            name: 'connection-te-token-case-insensitive-close',
            raw: `GET ${reqBase}/connection-te-case HTTP/1.1\r\nHost: 127.0.0.1:${TARGET_PORT}\r\nConnection: Keep-Alive, Te\r\n\r\n`,
            expectStatus: 200,
            expectConnectionClose: true
        },
        {
            name: 'tabs-inside-header-name-rejected',
            raw: `GET ${reqBase}/tab-header-name HTTP/1.1\r\nHost: 127.0.0.1:${TARGET_PORT}\r\nBad\tHeader: x\r\n\r\n`,
            expectStatus: 400
        },
        {
            name: 'invalid-cl-with-spaces-rejected',
            raw: `POST ${reqBase}/cl-space HTTP/1.1\r\nHost: 127.0.0.1:${TARGET_PORT}\r\nContent-Length: 1 2\r\n\r\n`,
            expectStatus: 400
        },
        {
            name: 'te-cl0-still-rejected',
            raw: `POST ${reqBase}/te-cl0 HTTP/1.1\r\nHost: 127.0.0.1:${TARGET_PORT}\r\nTransfer-Encoding: chunked\r\nContent-Length: 0\r\n\r\n0\r\n\r\n`,
            expectStatus: 400
        },
        {
            name: 'host-with-whitespace-before-colon-rejected',
            raw: `GET ${reqBase}/host-ws-colon HTTP/1.1\r\nHost : 127.0.0.1:${TARGET_PORT}\r\n\r\n`,
            expectStatus: 400
        },
        {
            name: 'header-name-leading-space-rejected',
            raw: `GET ${reqBase}/header-leading-space HTTP/1.1\r\nHost: 127.0.0.1:${TARGET_PORT}\r\n X-Test: value\r\n\r\n`,
            expectStatus: 400
        },
        {
            name: 'header-name-trailing-space-rejected',
            raw: `GET ${reqBase}/header-trailing-space HTTP/1.1\r\nHost: 127.0.0.1:${TARGET_PORT}\r\nX-Test : value\r\n\r\n`,
            expectStatus: 400
        },
        {
            name: 'header-name-parentheses-rejected',
            raw: `GET ${reqBase}/header-paren HTTP/1.1\r\nHost: 127.0.0.1:${TARGET_PORT}\r\nX(Test): value\r\n\r\n`,
            expectStatus: 400
        },
        {
            name: 'http-2-request-line-rejected',
            raw: `GET ${reqBase}/http2-line HTTP/2.0\r\nHost: 127.0.0.1:${TARGET_PORT}\r\n\r\n`,
            expectStatus: 400
        },
        {
            name: 'http-version-missing-minor-rejected',
            raw: `GET ${reqBase}/http-major-only HTTP/1\r\nHost: 127.0.0.1:${TARGET_PORT}\r\n\r\n`,
            expectStatus: 400
        },
        {
            name: 'url-userinfo-rejected',
            raw: `GET http://user:pass@127.0.0.1:${TARGET_PORT}/userinfo HTTP/1.1\r\nHost: 127.0.0.1:${TARGET_PORT}\r\n\r\n`,
            expectStatus: 400
        },
        {
            name: 'url-user-only-info-rejected',
            raw: `GET http://user@127.0.0.1:${TARGET_PORT}/userinfo2 HTTP/1.1\r\nHost: 127.0.0.1:${TARGET_PORT}\r\n\r\n`,
            expectStatus: 400
        },
        {
            name: 'te-whitespace-only-rejected',
            raw: `POST ${reqBase}/te-space-only HTTP/1.1\r\nHost: 127.0.0.1:${TARGET_PORT}\r\nTransfer-Encoding:     \r\n\r\n`,
            expectStatus: 400
        },
        {
            name: 'te-leading-comma-rejected',
            raw: `POST ${reqBase}/te-leading-comma HTTP/1.1\r\nHost: 127.0.0.1:${TARGET_PORT}\r\nTransfer-Encoding: ,chunked\r\n\r\n0\r\n\r\n`,
            expectStatus: 400
        },
        {
            name: 'te-trailing-comma-rejected',
            raw: `POST ${reqBase}/te-trailing-comma HTTP/1.1\r\nHost: 127.0.0.1:${TARGET_PORT}\r\nTransfer-Encoding: chunked,\r\n\r\n0\r\n\r\n`,
            expectStatus: 400
        },
        {
            name: 'te-empty-middle-token-rejected',
            raw: `POST ${reqBase}/te-empty-mid HTTP/1.1\r\nHost: 127.0.0.1:${TARGET_PORT}\r\nTransfer-Encoding: gzip,,chunked\r\n\r\n0\r\n\r\n`,
            expectStatus: 400
        },
        {
            name: 'te-token-with-slash-rejected',
            raw: `POST ${reqBase}/te-token-slash HTTP/1.1\r\nHost: 127.0.0.1:${TARGET_PORT}\r\nTransfer-Encoding: chunked/bad\r\n\r\n`,
            expectStatus: 400
        },
        {
            name: 'te-with-tab-between-tokens-accepted',
            raw: `POST ${reqBase}/te-tab-between HTTP/1.1\r\nHost: 127.0.0.1:${TARGET_PORT}\r\nTransfer-Encoding: gzip,\tchunked\r\n\r\n0\r\n\r\n`,
            expectStatus: 200
        },
        {
            name: 'post-with-cl-zero-kept-close-policy-safe',
            raw: `POST ${reqBase}/post-cl-zero HTTP/1.1\r\nHost: 127.0.0.1:${TARGET_PORT}\r\nContent-Length: 0\r\n\r\n`,
            expectStatus: 200,
            expectConnectionClose: true
        },
        {
            name: 'patch-method-forced-close',
            raw: `PATCH ${reqBase}/patch-close HTTP/1.1\r\nHost: 127.0.0.1:${TARGET_PORT}\r\nContent-Length: 4\r\n\r\nbody`,
            expectStatus: 200,
            expectConnectionClose: true
        },
        {
            name: 'trace-method-forced-close',
            raw: `TRACE ${reqBase}/trace-close HTTP/1.1\r\nHost: 127.0.0.1:${TARGET_PORT}\r\n\r\n`,
            expectStatus: 200,
            expectConnectionClose: true
        },
        {
            name: 'safe-head-not-closed',
            raw: `HEAD ${reqBase}/head-not-close HTTP/1.1\r\nHost: 127.0.0.1:${TARGET_PORT}\r\n\r\n`,
            expectStatus: 200
        },
        {
            name: 'safe-options-not-closed',
            raw: `OPTIONS ${reqBase}/options-not-close HTTP/1.1\r\nHost: 127.0.0.1:${TARGET_PORT}\r\n\r\n`,
            expectStatus: 200,
            expectConnectionNotClose: true
        },
        {
            name: 'connection-te-alone-forces-close',
            raw: `GET ${reqBase}/connection-te-alone HTTP/1.1\r\nHost: 127.0.0.1:${TARGET_PORT}\r\nConnection: TE\r\n\r\n`,
            expectStatus: 200,
            expectConnectionClose: true
        },
        {
            name: 'connection-transfer-encoding-token-forces-close',
            raw: `GET ${reqBase}/connection-transfer-encoding HTTP/1.1\r\nHost: 127.0.0.1:${TARGET_PORT}\r\nConnection: transfer-encoding\r\n\r\n`,
            expectStatus: 200,
            expectConnectionClose: true
        },
        {
            name: 'duplicate-host-case-variant-rejected',
            raw: `GET ${reqBase}/dup-host-case HTTP/1.1\r\nHost: 127.0.0.1:${TARGET_PORT}\r\nhost: 127.0.0.1:${TARGET_PORT}\r\n\r\n`,
            expectStatus: 400
        },
        {
            name: 'duplicate-host-conflict-rejected',
            raw: `GET ${reqBase}/dup-host-conflict-2 HTTP/1.1\r\nHost: 127.0.0.1:${TARGET_PORT}\r\nHost: 127.0.0.1:9\r\n\r\n`,
            expectStatus: 400
        },
        {
            name: 'content-length-zero-on-get-keepalive',
            raw: `GET ${reqBase}/get-cl0 HTTP/1.1\r\nHost: 127.0.0.1:${TARGET_PORT}\r\nContent-Length: 0\r\n\r\n`,
            expectStatus: 200,
            expectConnectionNotClose: true
        },
        {
            name: 'invalid-method-with-dash-rejected',
            raw: `GE-T ${reqBase}/bad-method HTTP/1.1\r\nHost: 127.0.0.1:${TARGET_PORT}\r\n\r\n`,
            expectStatus: 400
        },
        {
            name: 'invalid-request-target-whitespace-rejected',
            raw: `GET http://127.0.0.1:${TARGET_PORT}/bad target HTTP/1.1\r\nHost: 127.0.0.1:${TARGET_PORT}\r\n\r\n`,
            expectStatus: 400
        }
    ];

    // Deterministic mutation-style cases for broader hostile pattern coverage.
    const mutatedCases = [];

    const badContentLengthValues = [
        '+0',
        '+10',
        '-0',
        '-10',
        '1 0',
        '10  ',
        '  10',
        '10\t',
        '10,0',
        '0x10',
        '1e3',
        'NaN',
        'infinite',
        '18446744073709551616x'
    ];

    for (let i = 0; i < badContentLengthValues.length; i++) {
        const cl = badContentLengthValues[i];
        mutatedCases.push({
            name: `mut-cl-${i}-rejected`,
            raw: `POST ${reqBase}/mut-cl-${i} HTTP/1.1\r\nHost: 127.0.0.1:${TARGET_PORT}\r\nContent-Length: ${cl}\r\n\r\nbody`,
            expectStatus: 400
        });
    }

    const badTransferEncodingValues = [
        ',chunked',
        'chunked,',
        'gzip,,chunked',
        'chunked,,',
        ',,chunked',
        'chunked,@evil',
        'chunked/evil',
        'chunked ;x=1',
        ' chunked , ',
        'gzip, chunked,',
        'gzip, ,chunked'
    ];

    for (let i = 0; i < badTransferEncodingValues.length; i++) {
        const te = badTransferEncodingValues[i];
        mutatedCases.push({
            name: `mut-te-${i}-rejected`,
            raw: `POST ${reqBase}/mut-te-${i} HTTP/1.1\r\nHost: 127.0.0.1:${TARGET_PORT}\r\nTransfer-Encoding: ${te}\r\n\r\n0\r\n\r\n`,
            expectStatus: 400
        });
    }

    const badHeaderNameVariants = [
        'X Test',
        'X(Test)',
        'X[Test]',
        'X@Test',
        'X=Test',
        'X/Test',
        'X?Test',
        'X\\Test',
        'X\"Test',
        'X;Test'
    ];

    for (let i = 0; i < badHeaderNameVariants.length; i++) {
        const headerName = badHeaderNameVariants[i];
        mutatedCases.push({
            name: `mut-header-name-${i}-rejected`,
            raw: `GET ${reqBase}/mut-header-name-${i} HTTP/1.1\r\nHost: 127.0.0.1:${TARGET_PORT}\r\n${headerName}: value\r\n\r\n`,
            expectStatus: 400
        });
    }

    const badRequestLineVariants = [
        `GET  ${reqBase}/mut-rline-double-space HTTP/1.1`,
        `GET\t${reqBase}/mut-rline-tab HTTP/1.1`,
        `GET ${reqBase}/mut-rline-http09 HTTP/0.9`,
        `GET ${reqBase}/mut-rline-http12 HTTP/1.2`,
        `GET ${reqBase}/mut-rline-http20 HTTP/2.0`,
        `GET ${reqBase}/mut-rline-no-version`,
        `GET ${reqBase}/mut-rline-garbage HTTX/1.1`
    ];

    for (let i = 0; i < badRequestLineVariants.length; i++) {
        const requestLine = badRequestLineVariants[i];
        mutatedCases.push({
            name: `mut-request-line-${i}-rejected`,
            raw: `${requestLine}\r\nHost: 127.0.0.1:${TARGET_PORT}\r\n\r\n`,
            expectStatus: 400
        });
    }

    extraCases.push(...mutatedCases);

    for (const tc of extraCases) {
        const res = await sendRawProxyRequest(tc.raw);
        const parsed = extractJsonBody(res.body);
        let ok = res.statusCode === tc.expectStatus;

        if (ok && tc.bodyIncludes) {
            ok = !!(parsed && parsed.body && parsed.body.includes(tc.bodyIncludes));
        }

        if (ok && tc.expectConnectionClose) {
            ok = !!(parsed && parsed.headers && parsed.headers.connection === 'close');
        }

        if (ok && tc.expectConnectionNotClose) {
            ok = !!(parsed && parsed.headers && parsed.headers.connection !== 'close');
        }

        assert(ok, tc.name, res.statusLine);
    }

    console.log('==========================================');
    console.log(`Suspicious-pattern tests passed: ${passed}`);
    console.log(`Suspicious-pattern tests failed: ${failed}`);
    console.log('==========================================');

    if (!proxyProc.killed) proxyProc.kill('SIGKILL');
    if (!clientProc.killed) clientProc.kill('SIGKILL');
    await delay(300);
    await new Promise((resolve) => targetServer.close(resolve));

    if (failed > 0) {
        process.exitCode = 1;
    }
}

main().catch((err) => {
    console.error('Fatal error in suspicious-pattern test:', err);
    process.exit(1);
});
