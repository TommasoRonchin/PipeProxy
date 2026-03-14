const fs = require('fs');

process.on('uncaughtException', (err) => {
    console.error(`[ProxyServer] Uncaught Exception: ${err.message}`, err);
    process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error(`[ProxyServer] Unhandled Rejection:`, reason);
});

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
const { timingSafeEqual, CryptoStream } = require('../shared/cryptoStream');
const { encodeFrame, TYPES } = require('../shared/frameEncoder');

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
const FORCE_CONNECTION_CLOSE = process.env.FORCE_CONNECTION_CLOSE === 'true'; // Default false (better throughput, fewer churn stalls)
const SMART_HTTP_CLOSE = process.env.SMART_HTTP_CLOSE !== 'false'; // Default true: close only risky/plain-HTTP cases
const MAX_CONCURRENT_PROXY_CONNECTIONS = process.env.MAX_CONCURRENT_PROXY_CONNECTIONS ? parseInt(process.env.MAX_CONCURRENT_PROXY_CONNECTIONS, 10) : 500;

let activeProxyConnections = 0;

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

    return timingSafeEqual(username, PROXY_AUTH_USERNAME) && timingSafeEqual(password, PROXY_AUTH_PASSWORD);
}

function parseHeaderFraming(lines) {
    let transferEncoding = null;
    const contentLengthValues = [];

    for (let i = 1; i < lines.length; i++) {
        const line = lines[i];
        const colonIdx = line.indexOf(':');
        if (colonIdx === -1) continue;
        const name = line.substring(0, colonIdx).trim().toLowerCase();
        const value = line.substring(colonIdx + 1).trim();

        if (name === 'transfer-encoding') {
            transferEncoding = value.toLowerCase();
        } else if (name === 'content-length') {
            const parsed = parseInt(value, 10);
            if (!Number.isFinite(parsed) || parsed < 0) {
                return { invalid: true };
            }
            contentLengthValues.push(parsed);
        }
    }

    if (contentLengthValues.length > 1) {
        const first = contentLengthValues[0];
        for (let i = 1; i < contentLengthValues.length; i++) {
            if (contentLengthValues[i] !== first) {
                return { invalid: true };
            }
        }
    }

    return {
        invalid: false,
        transferEncoding,
        contentLength: contentLengthValues.length > 0 ? contentLengthValues[0] : null
    };
}

function shouldForceCloseForHttp({ method, framing, extraDataLength }) {
    if (FORCE_CONNECTION_CLOSE) return true;
    if (!SMART_HTTP_CLOSE) return false;

    // Always close on framed bodies to reduce parser-desync/smuggling surface.
    if (framing.transferEncoding) return true;
    if (framing.contentLength && framing.contentLength > 0) return true;

    // Keep-alive only for simple safe methods.
    const safeMethods = new Set(['GET', 'HEAD', 'OPTIONS']);
    return !safeMethods.has(method);
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

    // Connection limiting
    if (activeProxyConnections >= MAX_CONCURRENT_PROXY_CONNECTIONS) {
        console.warn(`[ProxyServer] Rejecting connection: Max concurrent proxy connections reached (${MAX_CONCURRENT_PROXY_CONNECTIONS})`);
        socket.end('HTTP/1.1 503 Service Unavailable\r\n\r\nServer Busy');
        socket.destroy();
        return;
    }
    activeProxyConnections++;

    // Slowloris Connection Exhaustion Protection
    // Use an absolute hard timer. socket.setTimeout resets on every byte received,
    // which allows an attacker to hold the connection open indefinitely by sending 1 byte very slowly.
    const hardTimeoutTimer = setTimeout(() => {
        if (!resolved) {
            console.warn(`[ProxyServer] Connection timed out during header parsing (Slowloris protection)`);
            socket.end('HTTP/1.1 408 Request Timeout\r\n\r\n');
            socket.destroy();
        }
    }, MAX_PROXY_TIMEOUT_MS);

    socket.on('close', () => {
        activeProxyConnections--;
        clearTimeout(hardTimeoutTimer);
    });

    const onData = (chunk) => {
        if (resolved) return;

        headerBuffer = Buffer.concat([headerBuffer, chunk]);

        const headerEndIdx = headerBuffer.indexOf('\r\n\r\n');

        // Slowloris OOM Protection
        if (headerEndIdx === -1) {
             if (headerBuffer.length > MAX_PROXY_HEADER_SIZE) {
                socket.end('HTTP/1.1 431 Request Header Fields Too Large\r\n\r\n');
                socket.destroy();
             }
             return;
        }

        if (headerEndIdx > MAX_PROXY_HEADER_SIZE) {
            socket.end('HTTP/1.1 431 Request Header Fields Too Large\r\n\r\n');
            socket.destroy();
            return;
        }

        resolved = true;
        clearTimeout(hardTimeoutTimer);
        socket.removeListener('data', onData);

        // Set Idle Timeout
        const IDLE_TIMEOUT_MS = process.env.IDLE_TIMEOUT_MS ? parseInt(process.env.IDLE_TIMEOUT_MS, 10) : 60000;
        socket.setTimeout(IDLE_TIMEOUT_MS);
        socket.on('timeout', () => {
            console.warn(`[ProxyServer] Connection idle timeout reached, closing socket`);
            socket.end();
            socket.destroy();
        });

        const headerText = headerBuffer.subarray(0, headerEndIdx).toString('utf8');

        // Perform Proxy Authentication
        if (!validateAuth(headerText)) {
            console.warn(`[ProxyServer] Authentication failed`);
            socket.end('HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="PipeProxy"\r\n\r\n');
            setImmediate(() => socket.destroy());
            return;
        }

        // Fast path for request line parsing
        const firstLineEnd = headerBuffer.indexOf('\r\n');
        const reqLine = headerBuffer.subarray(0, firstLineEnd).toString('utf8');
        const match = reqLine.match(/^([A-Z]+)\s+([^\s]+)\s+HTTP/);
        
        if (!match) {
            socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
            setImmediate(() => socket.destroy());
            return;
        }

        const method = match[1];
        const target = match[2];
        let host = null, port = 80;

        if (method === 'CONNECT') {
            const lastColonIdx = target.lastIndexOf(':');
            if (lastColonIdx !== -1 && (target.indexOf(']') === -1 || target.indexOf(']') < lastColonIdx)) {
                host = target.substring(0, lastColonIdx);
                port = parseInt(target.substring(lastColonIdx + 1), 10) || 443;
            } else {
                host = target;
                port = 443;
            }
            if (host.startsWith('[') && host.endsWith(']')) host = host.substring(1, host.length - 1);
        } else {
            try {
                const urlObj = new URL(target);
                host = urlObj.hostname;
                port = urlObj.port ? parseInt(urlObj.port, 10) : 80;
            } catch {
                socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
                setImmediate(() => socket.destroy());
                return;
            }
        }

        if (!host || isNaN(port) || port <= 0 || port > 65535) {
            socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
            setImmediate(() => socket.destroy());
            return;
        }

        if (!tunnelServer.isReady()) {
            socket.end('HTTP/1.1 502 Bad Gateway\r\n\r\nTunnel not connected\n');
            setImmediate(() => socket.destroy());
            return;
        }

        const connId = protocol.registerConnection(socket, host, port);
        if (!connId) return;

        const extraData = headerBuffer.subarray(headerEndIdx + 4);

        if (method === 'CONNECT') {
            if (extraData.length > 0) {
                tunnelServer.sendFrame(TYPES.DATA, connId, extraData);
            }

            const onOpenAck = (ackConnId) => {
                if (ackConnId === connId) {
                    protocol.removeListener('open_ack', onOpenAck);
                    protocol.removeListener('close', onClose);
                    if (!socket.destroyed) socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
                }
            };

            const onClose = (closeConnId) => {
                if (closeConnId === connId) {
                    protocol.removeListener('open_ack', onOpenAck);
                    protocol.removeListener('close', onClose);
                    if (!socket.destroyed && socket.writable) {
                        socket.end('HTTP/1.1 502 Bad Gateway\r\n\r\nConnection Refused by Target\r\n\r\n');
                    }
                    if (!socket.destroyed) socket.destroy();
                }
            };

            protocol.on('open_ack', onOpenAck);
            protocol.on('close', onClose);
            socket.on('close', () => {
                protocol.removeListener('open_ack', onOpenAck);
                protocol.removeListener('close', onClose);
            });
        } else {
            // Forward HTTP request, filter hop-by-hop headers
            const lines = headerText.split('\r\n');

            const framing = parseHeaderFraming(lines);
            if (framing.invalid) {
                socket.end('HTTP/1.1 400 Bad Request\r\n\r\nInvalid HTTP framing\n');
                setImmediate(() => socket.destroy());
                return;
            }

            if (framing.transferEncoding && framing.contentLength !== null) {
                socket.end('HTTP/1.1 400 Bad Request\r\n\r\nConflicting Transfer-Encoding/Content-Length\n');
                setImmediate(() => socket.destroy());
                return;
            }

            const forceCloseThisRequest = shouldForceCloseForHttp({
                method,
                framing,
                extraDataLength: extraData.length
            });
            
            // Rewrite first line if needed
            if (REWRITE_PROXY_URLS) {
                try {
                    const urlObj = new URL(target);
                    const pathTarget = (urlObj.pathname || '/') + (urlObj.search || '');
                    lines[0] = `${method} ${pathTarget} HTTP/1.1`;
                } catch {}
            }

            const hopByHopHeaders = ['proxy-authorization', 'proxy-connection', 'connection', 'keep-alive', 'upgrade', 'te', 'trailer'];
            const filteredLines = lines.filter((line, idx) => {
                if (idx === 0) return true;
                const colonIdx = line.indexOf(':');
                if (colonIdx === -1) return false;
                const name = line.substring(0, colonIdx).trim().toLowerCase();
                return !hopByHopHeaders.includes(name);
            });

            const safeHeader = filteredLines.join('\r\n') + (forceCloseThisRequest ? '\r\nConnection: close\r\n\r\n' : '\r\n\r\n');
            const packet = Buffer.concat([Buffer.from(safeHeader, 'utf8'), extraData]);
            tunnelServer.sendFrame(TYPES.DATA, connId, packet);
        }
    };

    socket.on('data', onData);
};

// 1. Initialize logic components and check configuration
const tunnelServer = new TunnelServer({ port: TUNNEL_PORT, secret: TUNNEL_SECRET });
const protocol = new FrameProtocol(tunnelServer);

tunnelServer.on('error', (err) => {
    console.error(`[ProxyServer] TunnelServer Runtime Error: ${err.message}`);
});

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

proxyServer.on('error', (err) => {
    console.error(`[ProxyServer] Global Server Error: ${err.message}`);
    if (err.code === 'EADDRINUSE') {
        console.error(`[ProxyServer] CRITICAL: Proxy port ${PROXY_PORT} is already in use.`);
        process.exit(1);
    }
});

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
