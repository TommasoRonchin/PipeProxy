const net = require('net');
const { spawn } = require('child_process');
const path = require('path');

console.log("--- Testing Global Error Handling on proxyServer ---");

// Bind port 3128 blocking the proxy
const blocker = net.createServer();
blocker.listen(3128, '127.0.0.1', () => {
    console.log("✅ Blocker listening on 3128...");

    // Spawn proxy Server
    const serverEnv = { ...process.env, SKIP_DOTENV: 'true', PORT: 3128, TUNNEL_PORT: 8080 };
    const serverProcess = spawn('node', [path.join(__dirname, 'server', 'proxyServer.js')], { env: serverEnv });
    
    let outBuf = '';
    serverProcess.stdout.on('data', d => outBuf += d);
    serverProcess.stderr.on('data', d => outBuf += d);

    serverProcess.on('close', (code) => {
        console.log("Proxy Output:");
        console.log(outBuf);
        if (outBuf.includes('CRITICAL: Port 3128 is already in use.')) {
            console.log("✅ Error listener successfully caught EADDRINUSE!");
            blocker.close();
            process.exit(0);
        } else {
            console.error("❌ Did not catch EADDRINUSE gracefully.");
            blocker.close();
            process.exit(1);
        }
    });
});
