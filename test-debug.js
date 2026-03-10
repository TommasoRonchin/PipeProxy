const { spawn } = require('child_process');
const path = require('path');
const serverEnv = {
    ...process.env,
    SKIP_DOTENV: 'true',
    PORT: 3128,
    TUNNEL_PORT: 8080,
    TUNNEL_SECRET: 'test_secret',
    ENABLE_PROXY_AUTH: 'true',
    PROXY_AUTH_USERNAME: 'admin',
    PROXY_AUTH_PASSWORD: 'Sup3r:P@ssword:!',
    ENABLE_SECURE_HANDSHAKE: 'true',
    BLOCK_LOCAL_NETWORK: 'true'
};
const clientEnv = {
    ...process.env,
    SKIP_DOTENV: 'true',
    SERVER_URL: 'ws://127.0.0.1:8080',
    TUNNEL_SECRET: 'test_secret',
    ENABLE_SECURE_HANDSHAKE: 'true',
    BLOCK_LOCAL_NETWORK: 'true'
};
const serverProcess = spawn('node', [path.join(__dirname, 'server', 'proxyServer.js')], { env: serverEnv });
serverProcess.stdout.on('data', output => { process.stdout.write("SERVER: " + output.toString()); });
serverProcess.stderr.on('data', output => { process.stdout.write("SERVER-ERR: " + output.toString()); });

const clientProcess = spawn('node', [path.join(__dirname, 'client', 'raspberryClient.js')], { env: clientEnv });
clientProcess.stdout.on('data', output => { process.stdout.write("CLIENT: " + output.toString()); });
clientProcess.stderr.on('data', output => { process.stdout.write("CLIENT-ERR: " + output.toString()); });

setTimeout(() => { serverProcess.kill(); clientProcess.kill(); process.exit(); }, 3000);
