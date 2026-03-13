const { CryptoStream } = require('../shared/cryptoStream');
const assert = require('assert');
const crypto = require('crypto');

process.env.ENCRYPTION_SECRET = 'test_secret_1234567890123456';
process.env.ENABLE_ENCRYPTION = 'true';

function testCryptoIntegrity() {
    console.log('Testing CryptoStream integrity...');
    const stream = new CryptoStream({ enableEncryption: true });

    const original = Buffer.from('Highly sensitive data payload');
    const encrypted = stream.encryptMessage(original);

    // Check structure: IV(12) + Tag(16) + Ciphertext(original.length + Seq(4))
    assert.strictEqual(encrypted.length, 12 + 16 + original.length + 4);

    stream.reset();
    const decrypted = stream.decryptMessage(encrypted);
    assert.deepStrictEqual(decrypted, original);
    console.log('✅ Basic integrity passed');
}

function testCryptoSequence() {
    console.log('Testing CryptoStream sequence tracking...');
    const stream = new CryptoStream({ enableEncryption: true, strictSequence: true });

    const m1 = Buffer.from('Message 1');
    const m2 = Buffer.from('Message 2');

    const e1 = stream.encryptMessage(m1);
    const e2 = stream.encryptMessage(m2);

    const decoderStream = new CryptoStream({ enableEncryption: true, strictSequence: true });

    assert.deepStrictEqual(decoderStream.decryptMessage(e1), m1);
    assert.deepStrictEqual(decoderStream.decryptMessage(e2), m2);

    // Test replay
    try {
        decoderStream.decryptMessage(e1);
        assert.fail('Should have thrown replay error');
    } catch (err) {
        assert.ok(err.message.includes('Replay Attack'));
    }
    console.log('✅ Sequence tracking passed');
}

try {
    testCryptoIntegrity();
    testCryptoSequence();
} catch (err) {
    console.error('❌ Test failed:', err);
    process.exit(1);
}
