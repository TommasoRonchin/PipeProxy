const FrameDecoder = require('../shared/frameDecoder');
const { encodeFrame, TYPES } = require('../shared/frameEncoder');
const assert = require('assert');

function testEdgeCases() {
    console.log('--- Stress Testing FrameDecoder Offset Logic ---');
    const decoder = new FrameDecoder();
    const payload = Buffer.alloc(100, 'x');
    const fullFrame = encodeFrame(TYPES.DATA, 1, payload);

    let received = [];
    decoder.on('frame', (f) => received.push(f));

    // Test 1: Multiple small pushes that offset the first chunk
    // Frame is 9 (header) + 100 (payload) = 109 bytes.
    decoder.push(fullFrame.subarray(0, 10)); // Chunk 1: [0, 10)
    decoder.push(fullFrame.subarray(10, 20)); // Chunk 2: [10, 20)
    
    // Process first 9 bytes
    // Frame header is read, but payload is incomplete.
    // totalLength is 20. Need 109.
    
    decoder.push(fullFrame.subarray(20)); // Chunk 3: [20, 109]
    
    assert.strictEqual(received.length, 1);
    assert.deepStrictEqual(received[0].payload, payload);
    console.log('✅ Test 1: Spanning chunks with offset passed');

    // Test 2: Exact chunk boundaries
    received = [];
    decoder._reset();
    const f1 = encodeFrame(TYPES.DATA, 1, Buffer.from('A')); // 10 bytes
    const f2 = encodeFrame(TYPES.DATA, 2, Buffer.from('B')); // 10 bytes
    
    // Push f1 + start of f2 header in one chunk
    decoder.push(Buffer.concat([f1, f2.subarray(0, 5)])); 
    // Frame 1 received. decoder.chunkOffset should be 10.
    assert.strictEqual(received.length, 1);
    
    decoder.push(f2.subarray(5));
    assert.strictEqual(received.length, 2);
    assert.strictEqual(received[1].connectionId, 2);
    console.log('✅ Test 2: Exact chunk boundary and offset reset passed');

    // Test 3: Large frames and OOM safety
    decoder._reset();
    process.env.MAX_FRAME_SIZE = '1000';
    const bigDecoder = new FrameDecoder();
    let errorCaught = false;
    bigDecoder.on('error', (err) => {
        console.log(`[DEBUG] Caught expected error: ${err.message}`);
        errorCaught = true;
    });
    
    // We want to trigger the "Frame too large" error specifically
    // So we push a frame that is larger than 1000 but NOT larger than 2000 (aggregate limit)
    const bigFrame = encodeFrame(TYPES.DATA, 1, Buffer.alloc(1100)); // ~1109 bytes
    bigDecoder.push(bigFrame);
    assert.strictEqual(errorCaught, true, 'OOM check failed to trigger');
    console.log('✅ Test 3: OOM protection (Single Frame) verified');

    // Test 4: Aggregate safety limit
    errorCaught = false;
    const giantFrame = encodeFrame(TYPES.DATA, 1, Buffer.alloc(2500));
    bigDecoder.push(giantFrame);
    assert.strictEqual(errorCaught, true, 'Aggregate OOM check failed to trigger');
    console.log('✅ Test 4: OOM protection (Aggregate) verified');

    console.log('--- Stress Test Complete ---');
}

testEdgeCases();
