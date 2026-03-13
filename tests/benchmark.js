const { performance } = require('perf_hooks');
const FrameDecoder = require('../shared/frameDecoder');
const { encodeFrame } = require('../shared/frameEncoder');
const { CryptoStream } = require('../shared/cryptoStream');
const crypto = require('crypto');

// Setup environment variables for constants
process.env.ENCRYPTION_SECRET = 'benchmark_secret_1234567890123456';
process.env.ENABLE_ENCRYPTION = 'true';

async function benchmarkFrameDecoder() {
    console.log('--- Benchmarking FrameDecoder (Baseline) ---');
    const decoder = new FrameDecoder();
    const payloadSize = 1024 * 1024; // 1MB payload
    const frame = encodeFrame(2, 1, Buffer.alloc(payloadSize, 'a'));

    // Split frame into small 4KB chunks to stress the concat logic
    const chunkSize = 4096;
    const chunks = [];
    for (let i = 0; i < frame.length; i += chunkSize) {
        chunks.push(frame.subarray(i, i + chunkSize));
    }

    const iterations = 50; // Total 50MB processed
    let framesReceived = 0;
    decoder.on('frame', () => {
        framesReceived++;
    });

    const start = performance.now();
    for (let i = 0; i < iterations; i++) {
        for (const chunk of chunks) {
            decoder.push(chunk);
        }
    }
    const end = performance.now();

    const duration = (end - start) / 1000;
    const totalMB = (iterations * frame.length) / (1024 * 1024);
    console.log(`Processed ${totalMB.toFixed(2)} MB in ${duration.toFixed(3)}s`);
    console.log(`Throughput: ${(totalMB / duration).toFixed(2)} MB/s`);
    console.log(`Frames received: ${framesReceived}`);
    console.log('-------------------------------------------\n');
}

async function benchmarkCryptoStream() {
    console.log('--- Benchmarking CryptoStream (Baseline) ---');
    const cryptoStream = new CryptoStream({
        enableEncryption: true,
        secret: process.env.ENCRYPTION_SECRET,
        sessionNonce: 'nonce'
    });

    const messageSize = 16 * 1024; // 16KB
    const message = Buffer.alloc(messageSize, 'b');
    const iterations = 5000; // ~80MB

    console.log('Testing Encryption...');
    const startEnc = performance.now();
    const encryptedMessages = [];
    for (let i = 0; i < iterations; i++) {
        encryptedMessages.push(cryptoStream.encryptMessage(message));
    }
    const endEnc = performance.now();
    const durationEnc = (endEnc - startEnc) / 1000;

    console.log('Testing Decryption...');
    // Reset sequence for decryption test
    cryptoStream.reset();
    const startDec = performance.now();
    for (let i = 0; i < iterations; i++) {
        cryptoStream.decryptMessage(encryptedMessages[i]);
    }
    const endDec = performance.now();
    const durationDec = (endDec - startDec) / 1000;

    const totalMB = (iterations * messageSize) / (1024 * 1024);
    console.log(`Encryption: ${totalMB.toFixed(2)} MB in ${durationEnc.toFixed(3)}s (${(totalMB / durationEnc).toFixed(2)} MB/s)`);
    console.log(`Decryption: ${totalMB.toFixed(2)} MB in ${durationDec.toFixed(3)}s (${(totalMB / durationDec).toFixed(2)} MB/s)`);
    console.log('-------------------------------------------\n');
}

async function run() {
    try {
        await benchmarkFrameDecoder();
        await benchmarkCryptoStream();
    } catch (err) {
        console.error('Benchmark failed:', err);
    }
}

run();
