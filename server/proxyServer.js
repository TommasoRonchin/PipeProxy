const fs = require('fs');
if (process.env.SKIP_DOTENV !== 'true') {
    if (fs.existsSync('.env')) {
        require('dotenv').config({ path: '.env' });
    } else {
        require('dotenv').config({ path: '.env.server' });
    }
}
const net = require('net');
const tls = require('tls');
const TunnelServer = require('./tunnelServer');
const FrameProtocol = require('./frameProtocol');

const PROXY_PORT = process.env.PORT || 3128;
const TUNNEL_PORT = process.env.TUNNEL_PORT || 8080;
const TUNNEL_SECRET = process.env.TUNNEL_SECRET;

const PROXY_AUTH_USERNAME = process.env.PROXY_AUTH_USERNAME;
const PROXY_AUTH_PASSWORD = process.env.PROXY_AUTH_PASSWORD;
const ENABLE_PROXY_AUTH = process.env.ENABLE_PROXY_AUTH === 'true';

const ENABLE_TLS_PROXY = process.env.ENABLE_TLS_PROXY === 'true';
const TLS_CERT_PATH = process.env.TLS_CERT_PATH;
const TLS_KEY_PATH = process.env.TLS_KEY_PATH;

const MAX_PROXY_HEADER_SIZE = process.env.MAX_PROXY_HEADER_SIZE ? parseInt(process.env.MAX_PROXY_HEADER_SIZE, 10) : 8192;
const MAX_PROXY_TIMEOUT_MS = process.env.MAX_PROXY_TIMEOUT_MS ? parseInt(process.env.MAX_PROXY_TIMEOUT_MS, 10) : 10000;
const REWRITE_PROXY_URLS = process.env.REWRITE_PROXY_URLS !== 'false'; // Default true

function validateAuth(headerText) {
    if (!ENABLE_PROXY_AUTH) return true; // Auth explicitly disabled
    if (!PROXY_AUTH_USERNAME || !PROXY_AUTH_PASSWORD) return true; // Missing credentials disables auth fallback

    const match = headerText.match(/Proxy-Authorization:\s*Basic\s+([^\r\n]+)/i);
    if (!match) return false;

    const credentials = Buffer.from(match[1], 'base64').toString('utf8');

    const splitIdx = credentials.indexOf(':');
    if (splitIdx === -1) return false;

    const username = credentials.substring(0, splitIdx);
    const password = credentials.substring(splitIdx + 1);

    const { timingSafeEqual } = require('../shared/cryptoStream');
    return timingSafeEqual(username, PROXY_AUTH_USERNAME) && timingSafeEqual(password, PROXY_AUTH_PASSWORD);
}


const proxyConnectionHandler = (socket) => {
    // Handle socket errors globally for this connection to prevent unhandled exceptions
    socket.on('error', (err) => {
        console.error(`[ProxyServer] Socket error: ${err.message}`);
        socket.destroy();
    });


    // Pre-authentication/parsing state
    let headerBuffer = Buffer.alloc(0);
    let resolved = false;

    // Slowloris Connection Exhaustion Protection
    socket.setTimeout(MAX_PROXY_TIMEOUT_MS);
    socket.once('timeout', () => {
        if (!resolved) {
            console.warn(`[ProxyServer] Connection timed out during header parsing`);
            socket.end('HTTP/1.1 408 Request Timeout\r\n\r\n');
            socket.destroy();
        }
    });

    const onData = (chunk) => {
        if (resolved) return;

        headerBuffer = Buffer.concat([headerBuffer, chunk]);

        // Slowloris OOM Protection
        if (headerBuffer.length > MAX_PROXY_HEADER_SIZE) {
            socket.end('HTTP/1.1 431 Request Header Fields Too Large\r\n\r\n');
            socket.destroy();
            return;
        }

        // Look for end of HTTP headers
        const headerEndIdx = headerBuffer.indexOf('\r\n\r\n');
        if (headerEndIdx !== -1) {
            resolved = true;
            socket.setTimeout(0); // clear timeout once headers are parsed
            socket.removeListener('data', onData);

            const headerText = headerBuffer.subarray(0, headerEndIdx).toString('utf8');

            // Perform Proxy Authentication
            if (!validateAuth(headerText)) {
                console.warn(`[ProxyServer] Authentication failed for a request`);
                socket.end('HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="PipeProxy"\r\n\r\n');
                setImmediate(() => socket.destroy());
                return;
            }

            const lines = headerText.split('\r\n');
            const reqLine = lines[0];

            // Parse request line: e.g. "CONNECT google.com:443 HTTP/1.1" or "GET http://example.com/ HTTP/1.1"
            const match = reqLine.match(/^([A-Z]+)\s+([^\s]+)\s+HTTP/);
            if (!match) {
                console.warn(`[ProxyServer] Malformed request line: ${reqLine}`);
                socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
                setImmediate(() => socket.destroy());
                return;
            }

            const method = match[1];
            const target = match[2];

            let host = null;
            let port = 80;

            if (method === 'CONNECT') {
                const lastColonIdx = target.lastIndexOf(':');
                if (lastColonIdx !== -1 && (target.indexOf(']') === -1 || target.indexOf(']') < lastColonIdx)) {
                    host = target.substring(0, lastColonIdx);
                    port = parseInt(target.substring(lastColonIdx + 1), 10) || 443;
                } else {
                    host = target;
                    port = 443;
                }
                // Remove brackets if IPv6
                if (host.startsWith('[') && host.endsWith(']')) {
                    host = host.substring(1, host.length - 1);
                }
            } else {
                // Plain HTTP proxy requests like http://example.com:8080/path
                try {
                    const urlObj = new URL(target);
                    host = urlObj.hostname;
                    port = urlObj.port ? parseInt(urlObj.port, 10) : 80;
                } catch (err) {
                    console.warn(`[ProxyServer] Failed to parse URL: ${target}`);
                    socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
                    setImmediate(() => socket.destroy());
                    return;
                }
            }

            if (!host || isNaN(port) || port <= 0 || port > 65535) {
                console.warn(`[ProxyServer] Rejecting request: Invalid host or port (${host}:${port})`);
                socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
                setImmediate(() => socket.destroy());
                return;
            }

            // Check tunnel readiness ONLY when we are actually ready to proxy
            if (!tunnelServer.isReady()) {
                socket.end('HTTP/1.1 502 Bad Gateway\r\n\r\nTunnel not connected\n');
                setImmediate(() => socket.destroy());
                return;
            }

            // Register connection
            const connId = protocol.registerConnection(socket, host, port);
            if (!connId) return;

            if (method === 'CONNECT') {
                // Reply with 200 OK directly, don't forward CONNECT frame payload upstream
                socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');

                // If there's extra data after \r\n\r\n, proxy it
                const extraData = headerBuffer.subarray(headerEndIdx + 4);
                if (extraData.length > 0) {
                    const { TYPES } = require('../shared/frameEncoder');
                    tunnelServer.sendFrame(TYPES.DATA, connId, extraData);
                }
            } else {
                // For standard HTTP proxy request, forward the payload upstream.
                // We must strip Proxy-Authorization to prevent credential leakage.
                const extraData = headerBuffer.subarray(headerEndIdx + 4);

                const linesToFilter = headerText.split('\r\n');

                // Rewrite first line to use absolute path instead of absolute URL (customizable)
                const reqLineMatch = linesToFilter[0].match(/^([A-Z]+)\s+([^\s]+)\s+(HTTP\/[1-9\.]+)$/);
                if (reqLineMatch && REWRITE_PROXY_URLS) {
                    try {
                        const urlObj = new URL(reqLineMatch[2]);
                        const pathTarget = (urlObj.pathname || '/') + (urlObj.search || '');
                        linesToFilter[0] = `${reqLineMatch[1]} ${pathTarget} ${reqLineMatch[3]}`;
                    } catch (e) {
                        // Ignore error, keep original line if parsing fails
                    }
                }

                const hopByHopHeaders = [
                    'proxy-authorization:',
                    'proxy-connection:',
                    'connection:',
                    'keep-alive:',
                    'upgrade:',
                    'te:',
                    'trailer:',
                    'transfer-encoding:'
                ];

                const safeHeaderText = linesToFilter
                    .filter(line => {
                        const lower = line.toLowerCase();
                        return !hopByHopHeaders.some(h => lower.startsWith(h));
                    })
                    .join('\r\n') + '\r\n\r\n';

                const safeHeaderBuffer = Buffer.concat([Buffer.from(safeHeaderText, 'utf8'), extraData]);

                const { TYPES } = require('../shared/frameEncoder');
                tunnelServer.sendFrame(TYPES.DATA, connId, safeHeaderBuffer);
            }
        }
    };

    socket.on('data', onData);
};

// 1. Initialize logic components and check configuration
const tunnelServer = new TunnelServer({ port: TUNNEL_PORT, secret: TUNNEL_SECRET });
const protocol = new FrameProtocol(tunnelServer);

// 2. Prepare the Proxy Server (TLS or Plain TCP)
let proxyServer;
if (ENABLE_TLS_PROXY) {
    try {
        if (!TLS_CERT_PATH || !TLS_KEY_PATH) {
            throw new Error("TLS_CERT_PATH or TLS_KEY_PATH is not defined");
        }
        const options = {
            key: fs.readFileSync(TLS_KEY_PATH),
            cert: fs.readFileSync(TLS_CERT_PATH)
        };
        proxyServer = tls.createServer(options, proxyConnectionHandler);
        console.log(`[ProxyServer] TLS/HTTPS enabled for Proxy port ${PROXY_PORT}`);
    } catch (err) {
        console.error(`[ProxyServer] CRITICAL: Failed to start TLS server: ${err.message}`);
        console.error(`[ProxyServer] Exiting because ENABLE_TLS_PROXY is set but TLS could not be initialized.`);
        process.exit(1);
    }
} else {
    proxyServer = net.createServer(proxyConnectionHandler);
    console.log(`[ProxyServer] Plain TCP HTTP Proxy enabled (No TLS) for port ${PROXY_PORT}`);
}

// 3. Start components
(async () => {
    try {
        await tunnelServer.start();

        proxyServer.listen(PROXY_PORT, () => {
            console.log(`[ProxyServer] Proxy is listening on port ${PROXY_PORT}`);
        });
    } catch (err) {
        if (err.code === 'EADDRINUSE') {
            console.error(`[ProxyServer] CRITICAL: Tunnel port ${TUNNEL_PORT} is already in use.`);
        } else {
            console.error(`[ProxyServer] CRITICAL: Failed to start Tunnel Server: ${err.message}`);
        }
        process.exit(1);
    }
})();
