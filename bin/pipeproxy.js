#!/usr/bin/env node

const { fork } = require('child_process');
const path = require('path');

const command = process.argv[2];
const rawArgs = process.argv.slice(3);

function parseBooleanFlag(value, flagName) {
    if (value === 'true' || value === '1') return 'true';
    if (value === 'false' || value === '0') return 'false';
    throw new Error(`Invalid value for ${flagName}: ${value}. Use true/false.`);
}

function setEnvFromPair(targetEnv, pair) {
    const idx = pair.indexOf('=');
    if (idx <= 0) {
        throw new Error(`Invalid --env format: ${pair}. Use KEY=VALUE.`);
    }
    const key = pair.slice(0, idx).trim();
    const value = pair.slice(idx + 1);
    if (!key) {
        throw new Error(`Invalid --env key in pair: ${pair}`);
    }
    targetEnv[key] = value;
}

function parseArgs(args, spec) {
    const childEnv = { ...process.env };
    const passthroughArgs = [];

    for (let i = 0; i < args.length; i++) {
        const token = args[i];

        if (token === '--') {
            passthroughArgs.push(...args.slice(i + 1));
            break;
        }

        if (token === '--env') {
            const pair = args[++i];
            if (!pair) {
                throw new Error('Missing value for --env. Use --env KEY=VALUE.');
            }
            setEnvFromPair(childEnv, pair);
            continue;
        }

        if (token.startsWith('--env=')) {
            setEnvFromPair(childEnv, token.slice('--env='.length));
            continue;
        }

        if (!token.startsWith('-')) {
            passthroughArgs.push(token);
            continue;
        }

        const map = spec[token];
        if (!map) {
            throw new Error(`Unknown option: ${token}`);
        }

        if (map.type === 'boolean') {
            childEnv[map.env] = map.value;
            continue;
        }

        const value = args[++i];
        if (!value) {
            throw new Error(`Missing value for ${token}`);
        }

        if (map.type === 'booleanValue') {
            childEnv[map.env] = parseBooleanFlag(value, token);
        } else {
            childEnv[map.env] = value;
        }
    }

    return { childEnv, passthroughArgs };
}

function runScript(relativeScriptPath, parsed) {
    const scriptPath = path.resolve(__dirname, '..', relativeScriptPath);
    const child = fork(scriptPath, parsed.passthroughArgs, {
        stdio: 'inherit',
        env: parsed.childEnv
    });

    child.on('exit', (code, signal) => {
        if (signal) {
            process.kill(process.pid, signal);
            return;
        }
        process.exit(code || 0);
    });
}

function printHelp() {
    console.log('PipeProxy CLI');
    console.log('');
    console.log('Usage:');
    console.log('  pipeproxy <command> [options]');
    console.log('');
    console.log('Commands:');
    console.log('  server   Start proxy + tunnel server node');
    console.log('  client   Start tunnel client node');
    console.log('  help     Show this help message');
    console.log('');
    console.log('Common options:');
    console.log('  --env KEY=VALUE              Override any env variable');
    console.log('');
    console.log('Server options:');
    console.log('  -p, --port <n>               Set PORT');
    console.log('  -t, --tunnel-port <n>        Set TUNNEL_PORT');
    console.log('  -s, --tunnel-secret <value>  Set TUNNEL_SECRET');
    console.log('  --proxy-user <value>         Set PROXY_AUTH_USERNAME');
    console.log('  --proxy-pass <value>         Set PROXY_AUTH_PASSWORD');
    console.log('  --proxy-auth                 Set ENABLE_PROXY_AUTH=true');
    console.log('  --no-proxy-auth              Set ENABLE_PROXY_AUTH=false');
    console.log('  --tls-proxy                  Set ENABLE_TLS_PROXY=true');
    console.log('  --no-tls-proxy               Set ENABLE_TLS_PROXY=false');
    console.log('  --tls-cert <path>            Set TLS_CERT_PATH');
    console.log('  --tls-key <path>             Set TLS_KEY_PATH');
    console.log('');
    console.log('Client options:');
    console.log('  -u, --server-url <url>       Set SERVER_URL');
    console.log('  -s, --tunnel-secret <value>  Set TUNNEL_SECRET');
    console.log('  -r, --reconnect-delay <ms>   Set RECONNECT_DELAY_MS');
    console.log('  --secure-handshake           Set ENABLE_SECURE_HANDSHAKE=true');
    console.log('  --no-secure-handshake        Set ENABLE_SECURE_HANDSHAKE=false');
    console.log('  --encryption                 Set ENABLE_ENCRYPTION=true');
    console.log('  --no-encryption              Set ENABLE_ENCRYPTION=false');
    console.log('  --encryption-secret <value>  Set ENCRYPTION_SECRET');
    console.log('');
    console.log('Examples:');
    console.log('  npx pipeproxy server -p 3128 -t 8080 -s mysecret');
    console.log('  npx pipeproxy client -u ws://1.2.3.4:8080 -s mysecret');
    console.log('  npx pipeproxy server --env MAX_PROXY_TIMEOUT_MS=15000');
    console.log('  npm run server');
    console.log('  npm run client');
}

function parseServerArgs(args) {
    const spec = {
        '-p': { env: 'PORT', type: 'value' },
        '--port': { env: 'PORT', type: 'value' },
        '-t': { env: 'TUNNEL_PORT', type: 'value' },
        '--tunnel-port': { env: 'TUNNEL_PORT', type: 'value' },
        '-s': { env: 'TUNNEL_SECRET', type: 'value' },
        '--tunnel-secret': { env: 'TUNNEL_SECRET', type: 'value' },
        '--proxy-user': { env: 'PROXY_AUTH_USERNAME', type: 'value' },
        '--proxy-pass': { env: 'PROXY_AUTH_PASSWORD', type: 'value' },
        '--proxy-auth': { env: 'ENABLE_PROXY_AUTH', type: 'boolean', value: 'true' },
        '--no-proxy-auth': { env: 'ENABLE_PROXY_AUTH', type: 'boolean', value: 'false' },
        '--tls-proxy': { env: 'ENABLE_TLS_PROXY', type: 'boolean', value: 'true' },
        '--no-tls-proxy': { env: 'ENABLE_TLS_PROXY', type: 'boolean', value: 'false' },
        '--tls-cert': { env: 'TLS_CERT_PATH', type: 'value' },
        '--tls-key': { env: 'TLS_KEY_PATH', type: 'value' }
    };
    return parseArgs(args, spec);
}

function parseClientArgs(args) {
    const spec = {
        '-u': { env: 'SERVER_URL', type: 'value' },
        '--server-url': { env: 'SERVER_URL', type: 'value' },
        '-s': { env: 'TUNNEL_SECRET', type: 'value' },
        '--tunnel-secret': { env: 'TUNNEL_SECRET', type: 'value' },
        '-r': { env: 'RECONNECT_DELAY_MS', type: 'value' },
        '--reconnect-delay': { env: 'RECONNECT_DELAY_MS', type: 'value' },
        '--secure-handshake': { env: 'ENABLE_SECURE_HANDSHAKE', type: 'boolean', value: 'true' },
        '--no-secure-handshake': { env: 'ENABLE_SECURE_HANDSHAKE', type: 'boolean', value: 'false' },
        '--encryption': { env: 'ENABLE_ENCRYPTION', type: 'boolean', value: 'true' },
        '--no-encryption': { env: 'ENABLE_ENCRYPTION', type: 'boolean', value: 'false' },
        '--encryption-secret': { env: 'ENCRYPTION_SECRET', type: 'value' }
    };
    return parseArgs(args, spec);
}

function failWithHelp(errorMessage) {
    console.error(errorMessage);
    console.error('Use "pipeproxy help" to list available commands.');
    process.exit(1);
}

switch (command) {
    case 'server': {
        if (rawArgs.includes('--help') || rawArgs.includes('-h')) {
            printHelp();
            break;
        }
        try {
            runScript('server/proxyServer.js', parseServerArgs(rawArgs));
        } catch (error) {
            failWithHelp(error.message);
        }
        break;
    }
    case 'client': {
        if (rawArgs.includes('--help') || rawArgs.includes('-h')) {
            printHelp();
            break;
        }
        try {
            runScript('client/raspberryClient.js', parseClientArgs(rawArgs));
        } catch (error) {
            failWithHelp(error.message);
        }
        break;
    }
    case 'help':
    case '--help':
    case '-h':
        printHelp();
        break;
    case '--version':
    case '-v': {
        const packageJson = require(path.resolve(__dirname, '..', 'package.json'));
        console.log(packageJson.version);
        break;
    }
    default:
        if (!command) {
            printHelp();
            process.exit(1);
        }
        failWithHelp(`Unknown command: ${command}`);
}
