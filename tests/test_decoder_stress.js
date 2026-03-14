const FrameDecoder = require('../shared/frameDecoder');
const { encodeFrame, TYPES } = require('../shared/frameEncoder');
const assert = require('assert');

async function testInterleaved() {
    console.log('Testing FrameDecoder Interleaving...');
    const decoder = new FrameDecoder();
    let framesSeen = 0;
    decoder.on('frame', ({ type, connectionId, payload }) => {
        framesSeen++;
        assert.strictEqual(type, TYPES.DATA);
        assert.strictEqual(payload.length, 1024 * 1024); // 1MB
    });

    const numFrames = 500; // More than 224 to check limits
    const frame = encodeFrame(TYPES.DATA, 1, Buffer.alloc(1024 * 1024, 'a'));
    
    // Split the 1MB frame into many small 1KB chunks to stress the decoder logic
    const chunkSize = 1024;
    for (let i = 0; i < numFrames; i++) {
        for (let j = 0; j < frame.length; j += chunkSize) {
            decoder.push(frame.subarray(j, j + chunkSize));
        }
        if (i % 50 === 0) process.stdout.write('.');
    }
    process.stdout.write('\n');
    
    assert.strictEqual(framesSeen, numFrames);
    console.log(`Success! Decoded ${framesSeen} interleaved frames.`);
}

async function run() {
    try {
        await testInterleaved();
    } catch (e) {
        console.error('Test Failed:', e);
        process.exit(1);
    }
}
run();
