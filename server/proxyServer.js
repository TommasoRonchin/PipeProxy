const fs = require('fs');
if (fs.existsSync('.env')) {
    require('dotenv').config({ path: '.env' });
} else {
    require('dotenv').config({ path: '.env.server' });
}
const net = require('net');
const TunnelServer = require('./tunnelServer');
const FrameProtocol = require('./frameProtocol');

const PROXY_PORT = process.env.PORT || 3128;
const TUNNEL_PORT = process.env.TUNNEL_PORT || 8080;
const TUNNEL_SECRET = process.env.TUNNEL_SECRET;

const PROXY_AUTH_USERNAME = process.env.PROXY_AUTH_USERNAME;
const PROXY_AUTH_PASSWORD = process.env.PROXY_AUTH_PASSWORD;
const ENABLE_PROXY_AUTH = process.env.ENABLE_PROXY_AUTH === 'true';

function validateAuth(headerText) {
    if (!ENABLE_PROXY_AUTH) return true; // Auth explicitly disabled
    if (!PROXY_AUTH_USERNAME || !PROXY_AUTH_PASSWORD) return true; // Missing credentials disables auth fallback

    const match = headerText.match(/Proxy-Authorization:\s*Basic\s+([^\r\n]+)/i);
    if (!match) return false;

    const credentials = Buffer.from(match[1], 'base64').toString('utf8');
    const [username, password] = credentials.split(':');

    return username === PROXY_AUTH_USERNAME && password === PROXY_AUTH_PASSWORD;
}

const tunnelServer = new TunnelServer({ port: TUNNEL_PORT, secret: TUNNEL_SECRET });
tunnelServer.start();

const protocol = new FrameProtocol(tunnelServer);

const proxyServer = net.createServer((socket) => {
    if (!tunnelServer.isReady()) {
        socket.end('HTTP/1.1 502 Bad Gateway\r\n\r\nTunnel not connected\n');
        return;
    }

    // Pre-authentication/parsing state
    let headerBuffer = Buffer.alloc(0);
    let resolved = false;

    const onData = (chunk) => {
        if (resolved) return;

        headerBuffer = Buffer.concat([headerBuffer, chunk]);

        // Look for end of HTTP headers
        const headerEndIdx = headerBuffer.indexOf('\r\n\r\n');
        if (headerEndIdx !== -1) {
            resolved = true;
            socket.removeListener('data', onData);

            const headerText = headerBuffer.subarray(0, headerEndIdx).toString('utf8');

            // Perform Proxy Authentication
            if (!validateAuth(headerText)) {
                socket.end('HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="PipeProxy"\r\n\r\n');
                return;
            }

            const lines = headerText.split('\r\n');
            const reqLine = lines[0];

            // Parse request line: e.g. "CONNECT google.com:443 HTTP/1.1" or "GET http://example.com/ HTTP/1.1"
            const match = reqLine.match(/^([A-Z]+)\s+([^\s]+)\s+HTTP/);
            if (!match) {
                socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
                return;
            }

            const method = match[1];
            const target = match[2];

            let host = null;
            let port = 80;

            if (method === 'CONNECT') {
                const parts = target.split(':');
                host = parts[0];
                port = parseInt(parts[1], 10) || 443;
            } else {
                // Plain HTTP proxy requests like http://example.com:8080/path
                try {
                    const urlObj = new URL(target);
                    host = urlObj.hostname;
                    port = urlObj.port ? parseInt(urlObj.port, 10) : 80;
                } catch (err) {
                    socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
                    return;
                }
            }

            if (!host) {
                socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
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
                // For standard HTTP proxy request, forward the entire original payload upstream.
                // Wait, standard HTTP proxies usually forward modified headers (no absolute URL, no Proxy-Connection).
                // But many servers handle absolute URL correctly. We will forward the raw payload as is, 
                // which includes the full HTTP request with http://...
                const { TYPES } = require('../shared/frameEncoder');
                tunnelServer.sendFrame(TYPES.DATA, connId, headerBuffer);
            }
        }
    };

    socket.on('data', onData);

    // Handled errors gracefully during pre-resolution
    socket.on('error', () => { /* ignore */ });
});

proxyServer.listen(PROXY_PORT, () => {
    console.log(`[ProxyServer] Raw TCP HTTP/HTTPS Proxy listening on port ${PROXY_PORT}`);
});
