const FrameDecoder = require('../shared/frameDecoder');
const { encodeFrame, TYPES } = require('../shared/frameEncoder');
const assert = require('assert');

function testFragmentation() {
    console.log('Testing FrameDecoder fragmentation...');
    const decoder = new FrameDecoder();
    const payload = Buffer.from('Hello Fragmentation Test');
    const fullFrame = encodeFrame(TYPES.DATA, 12345, payload);

    let frameCount = 0;
    decoder.on('frame', (frame) => {
        frameCount++;
        assert.strictEqual(frame.type, TYPES.DATA);
        assert.strictEqual(frame.connectionId, 12345);
        assert.deepStrictEqual(frame.payload, payload);
    });

    // Split into tiny pieces
    for (let i = 0; i < fullFrame.length; i++) {
        decoder.push(fullFrame.subarray(i, i + 1));
    }

    assert.strictEqual(frameCount, 1, 'Should have received exactly 1 frame');
    console.log('✅ Fragmentation test passed');
}

function testMultipleFramesInOneChunk() {
    console.log('Testing Multiple frames in one chunk...');
    const decoder = new FrameDecoder();
    const p1 = Buffer.from('Payload 1');
    const p2 = Buffer.from('Payload 2');
    const f1 = encodeFrame(TYPES.DATA, 1, p1);
    const f2 = encodeFrame(TYPES.DATA, 2, p2);

    let received = [];
    decoder.on('frame', (f) => received.push(f));

    decoder.push(Buffer.concat([f1, f2]));

    assert.strictEqual(received.length, 2);
    assert.deepStrictEqual(received[0].payload, p1);
    assert.deepStrictEqual(received[1].payload, p2);
    console.log('✅ Multiple frames test passed');
}

try {
    testFragmentation();
    testMultipleFramesInOneChunk();
} catch (err) {
    console.error('❌ Test failed:', err);
    process.exit(1);
}
