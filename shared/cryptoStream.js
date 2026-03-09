const crypto = require('crypto');

let key = null;
let isEncryptionEnabled = false;

function initCrypto() {
    isEncryptionEnabled = process.env.ENABLE_ENCRYPTION === 'true';
    if (isEncryptionEnabled) {
        const secret = process.env.ENCRYPTION_SECRET || 'default_secret';
        key = crypto.createHash('sha256').update(secret).digest();
    }
}

function encryptMessage(buffer) {
    if (key === null) initCrypto();
    if (!isEncryptionEnabled) return buffer;

    // Generate a random 12-byte Initialization Vector (IV) for GCM mode
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);

    // Encrypt the payload
    const encrypted = Buffer.concat([cipher.update(buffer), cipher.final()]);
    // Get the Authentication Tag (16 bytes by default in GCM)
    const authTag = cipher.getAuthTag();

    // Payload structure: [ IV (12) ][ AuthTag (16) ][ CipherText ]
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

    return Buffer.concat([decipher.update(encrypted), decipher.final()]);
}

module.exports = {
    encryptMessage,
    decryptMessage
};
