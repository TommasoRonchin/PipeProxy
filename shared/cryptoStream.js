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

    // Generate a random 16-byte Initialization Vector (IV) for this specific message
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-256-ctr', key, iv);

    // Encrypt the payload and concat IV + CipherText
    const encrypted = Buffer.concat([cipher.update(buffer), cipher.final()]);
    return Buffer.concat([iv, encrypted]);
}

function decryptMessage(buffer) {
    if (key === null) initCrypto();
    if (!isEncryptionEnabled) return buffer;

    if (buffer.length < 16) {
        throw new Error('Encrypted payload too short to contain IV');
    }

    // Extract the 16-byte IV from the start
    const iv = buffer.subarray(0, 16);
    const encrypted = buffer.subarray(16);

    const decipher = crypto.createDecipheriv('aes-256-ctr', key, iv);
    return Buffer.concat([decipher.update(encrypted), decipher.final()]);
}

module.exports = {
    encryptMessage,
    decryptMessage
};
