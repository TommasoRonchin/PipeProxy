const { CryptoStream } = require('./shared/cryptoStream');

console.log("--- Testing Session-Based Key Derivation ---");

const secret = "my_super_secret_tunnel_key";
const plaintext = Buffer.from("Hello World, this is a test payload!");

// Client 1 connects with Nonce A
const nonceA = "session_nonce_A_1234567890";
const stream1 = new CryptoStream({
    enableEncryption: true,
    secret: secret,
    sessionNonce: nonceA,
    strictSequence: true
});

// Client 2 connects with Nonce B
const nonceB = "session_nonce_B_0987654321";
const stream2 = new CryptoStream({
    enableEncryption: true,
    secret: secret,
    sessionNonce: nonceB,
    strictSequence: true
});

// Both encrypt the exact same plaintext (their first message, so outSeq is 0 for both)
const cipher1 = stream1.encryptMessage(plaintext);
const cipher2 = stream2.encryptMessage(plaintext);

console.log("Cipher 1 length:", cipher1.length);
console.log("Cipher 2 length:", cipher2.length);

if (cipher1.equals(cipher2)) {
    console.error("❌ FAIL: Ciphertexts are IDENTICAL! Session Nonce is not working. IV collision risk remains.");
    process.exit(1);
} else {
    console.log("✅ PASS: Ciphertexts are completely different for the same plaintext and secret.");
}

// Ensure decryption works correctly within the same session
const stream1Receiver = new CryptoStream({
    enableEncryption: true,
    secret: secret,
    sessionNonce: nonceA,
    strictSequence: true
});

try {
    const decrypted = stream1Receiver.decryptMessage(cipher1);
    if (decrypted.equals(plaintext)) {
        console.log("✅ PASS: Decryption works correctly with matching session nonce.");
    } else {
        console.error("❌ FAIL: Decrypted text does not match original.");
        process.exit(1);
    }
} catch (e) {
    console.error("❌ FAIL: Decryption threw error:", e.message);
    process.exit(1);
}

// Ensure decryption FAILS across different sessions
const stream2Receiver = new CryptoStream({
    enableEncryption: true,
    secret: secret,
    sessionNonce: nonceB,
    strictSequence: true
});

try {
    stream2Receiver.decryptMessage(cipher1);
    console.error("❌ FAIL: Decryption SUCCEEDED with WRONG session nonce! This should not happen.");
    process.exit(1);
} catch (e) {
    console.log("✅ PASS: Decryption correctly fails when using a different session nonce.");
    console.log("   -> Error message:", e.message);
}

console.log("\n🎉 All session key tests passed!");
process.exit(0);
