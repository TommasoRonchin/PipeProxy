const crypto = require('crypto');

let key = null;
let isEncryptionEnabled = false;

// Replay attack prevention: sequence numbers
let outSeq = 0;
let expectedInSeq = 0;

function initCrypto() {
    isEncryptionEnabled = process.env.ENABLE_ENCRYPTION === 'true';
    if (isEncryptionEnabled) {
        const secret = process.env.ENCRYPTION_SECRET || 'default_secret';
        key = crypto.createHash('sha256').update(secret).digest();
    }
    outSeq = 0;
    expectedInSeq = 0;
}

// Reset sequence trackers when resetting the connection
function resetCryptoStream() {
    outSeq = 0;
    expectedInSeq = 0;
}

function encryptMessage(buffer) {
    if (key === null) initCrypto();
    if (!isEncryptionEnabled) return buffer;

    // Generate a random 12-byte Initialization Vector (IV) for GCM mode
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);

    // Replay Attack Protection: Embed an incremental 4-byte Sequence Number inside the encrypted payload
    const seqBuffer = Buffer.alloc(4);
    seqBuffer.writeUInt32BE(outSeq, 0);
    outSeq = (outSeq + 1) >>> 0; // Increment and wrap securely at 32-bit limit

    // Encrypt the payload prefixed with the Sequence Number
    const payloadWithSeq = Buffer.concat([seqBuffer, buffer]);
    const encrypted = Buffer.concat([cipher.update(payloadWithSeq), cipher.final()]);

    // Get the Authentication Tag (16 bytes by default in GCM)
    const authTag = cipher.getAuthTag();

    // Transport packet structure: [ IV (12) ][ AuthTag (16) ][ CipherText ]
    return Buffer.concat([iv, authTag, encrypted]);
}

function decryptMessage(buffer) {
    if (key === null) initCrypto();
    if (!isEncryptionEnabled) return buffer;

    // GCM Payload structure: [ IV (12) ][ AuthTag (16) ][ CipherText ]
    if (buffer.length < 28) {
        throw new Error('Encrypted payload too short to contain IV and AuthTag');
    }

    // Extract IV (12 bytes), AuthTag (16 bytes) and the encrypted data
    const iv = buffer.subarray(0, 12);
    const authTag = buffer.subarray(12, 28);
    const encrypted = buffer.subarray(28);

    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(authTag);

    const decryptedPayloadWithSeq = Buffer.concat([decipher.update(encrypted), decipher.final()]);

    // Extact and verify Sequence Number to prevent Replay Attacks
    if (decryptedPayloadWithSeq.length < 4) {
        throw new Error('Encrypted payload missing sequence number');
    }

    const seq = decryptedPayloadWithSeq.readUInt32BE(0);

    // Expected strict incrementing. If it's less than expected, we reject as a replay!
    if (seq < expectedInSeq) {
        throw new Error(`Replay Attack Detected: Received sequence ${seq}, expected at least ${expectedInSeq}`);
    }

    // Update our tracker for the next acceptable message
    expectedInSeq = (seq + 1) >>> 0;

    return decryptedPayloadWithSeq.subarray(4);
}

module.exports = {
    encryptMessage,
    decryptMessage,
    resetCryptoStream
};
