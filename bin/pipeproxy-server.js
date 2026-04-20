#!/usr/bin/env node

const { fork } = require('child_process');
const path = require('path');

const scriptPath = path.resolve(__dirname, 'pipeproxy.js');
const child = fork(scriptPath, ['server', ...process.argv.slice(2)], {
    stdio: 'inherit',
    env: process.env
});

child.on('exit', (code, signal) => {
    if (signal) {
        process.kill(process.pid, signal);
        return;
    }
    process.exit(code || 0);
});
