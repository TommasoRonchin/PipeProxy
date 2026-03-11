const { CryptoStream } = require('./shared/cryptoStream.js');

// Mock Env
process.env.ENABLE_ENCRYPTION = 'true';
process.env.ENCRYPTION_SECRET = 'test_secret_for_crypto_replay';

// Setup instance
const stream = new CryptoStream({
    enableEncryption: true,
    secret: 'test_secret_for_crypto_replay'
});

// Dummy data frame
const dataFrame1 = Buffer.from('hello server this is message 1');
const dataFrame2 = Buffer.from('hello server this is message 2');

console.log('--- Testing Encrypted Stream MITM Replay Defenses ---');

try {
    const encrypted1 = stream.encryptMessage(dataFrame1);
    const encrypted2 = stream.encryptMessage(dataFrame2);

    console.log('✅ Generated encrypted packets.');

    // Server receives Packet 1
    const decrypted1 = stream.decryptMessage(encrypted1);
    console.log(`✅ Packet 1 decrypted successfully: "${decrypted1.toString()}"`);

    // Interceptor (MITM) tries to resend Packet 1 again
    console.log('⚠️  MITM Attack: Resending Packet 1...');
    try {
        const decryptedDuplicate = stream.decryptMessage(encrypted1);
        console.error('❌ M-I-T-M ATTACK SUCCESSFUL: Server accepted replayed packet!');
        process.exit(1);
    } catch (e) {
        if (e.message.includes('Replay Attack Detected')) {
            console.log(`✅ Defense Worked! Packet rejected with error: ${e.message}`);
        } else {
            console.error('❌ Failed for unexpected reason:', e.message);
            process.exit(1);
        }
    }

    // Server receives Packet 2 (Valid, later sequence)
    const decrypted2 = stream.decryptMessage(encrypted2);
    console.log(`✅ Packet 2 decrypted successfully: "${decrypted2.toString()}"`);

    console.log('\n✅ All crypto tests passed! Replay attacks are mitigated.');
    process.exit(0);
} catch (err) {
    console.error('❌ Setup Error:', err.message);
    process.exit(1);
}
