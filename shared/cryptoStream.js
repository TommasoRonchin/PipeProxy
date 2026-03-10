const crypto = require('crypto');

/**
 * CryptoStream handles session-based encryption and replay protection.
 * It is no longer global to allow multiple concurrent tunnels.
 */
class CryptoStream {
    constructor(options = {}) {
        this.isEncryptionEnabled = options.enableEncryption === true;
        this.isStrictSequenceEnabled = options.strictSequence !== false;

        const secret = options.secret || process.env.ENCRYPTION_SECRET;
        if (this.isEncryptionEnabled && (!secret || secret === 'default_secret')) {
            throw new Error('CRITICAL: ENABLE_ENCRYPTION is true but no secure ENCRYPTION_SECRET was provided.');
        }
        this.key = crypto.createHash('sha256').update(secret || 'fallback_for_disabled_encryption').digest();

        // Replay attack prevention: sequence numbers per instance
        this.outSeq = 0;
        this.expectedInSeq = 0;
    }

    /**
     * Resets sequence trackers (useful on reconnection)
     */
    reset() {
        this.outSeq = 0;
        this.expectedInSeq = 0;
    }

    encryptMessage(buffer) {
        if (!this.isEncryptionEnabled) return buffer;

        // Generate a random 12-byte Initialization Vector (IV) for GCM mode
        const iv = crypto.randomBytes(12);
        const cipher = crypto.createCipheriv('aes-256-gcm', this.key, iv);

        // Replay Attack Protection: Embed an incremental 4-byte Sequence Number inside the encrypted payload
        const seqBuffer = Buffer.alloc(4);
        seqBuffer.writeUInt32BE(this.outSeq, 0);
        this.outSeq = (this.outSeq + 1) >>> 0; // Increment and wrap securely at 32-bit limit

        // Encrypt the payload prefixed with the Sequence Number
        const payloadWithSeq = Buffer.concat([seqBuffer, buffer]);
        const encrypted = Buffer.concat([cipher.update(payloadWithSeq), cipher.final()]);

        // Get the Authentication Tag (16 bytes by default in GCM)
        const authTag = cipher.getAuthTag();

        // Transport packet structure: [ IV (12) ][ AuthTag (16) ][ CipherText ]
        return Buffer.concat([iv, authTag, encrypted]);
    }

    decryptMessage(buffer) {
        if (!this.isEncryptionEnabled) return buffer;

        // GCM Payload structure: [ IV (12) ][ AuthTag (16) ][ CipherText ]
        if (buffer.length < 28) {
            throw new Error('Encrypted payload too short to contain IV and AuthTag');
        }

        // Extract IV (12 bytes), AuthTag (16 bytes) and the encrypted data
        const iv = buffer.subarray(0, 12);
        const authTag = buffer.subarray(12, 28);
        const encrypted = buffer.subarray(28);

        const decipher = crypto.createDecipheriv('aes-256-gcm', this.key, iv);
        decipher.setAuthTag(authTag);

        const decryptedPayloadWithSeq = Buffer.concat([decipher.update(encrypted), decipher.final()]);

        // Extract and verify Sequence Number to prevent Replay Attacks
        if (decryptedPayloadWithSeq.length < 4) {
            throw new Error('Encrypted payload missing sequence number');
        }

        const seq = decryptedPayloadWithSeq.readUInt32BE(0);

        // Expected strict incrementing.
        if (this.isStrictSequenceEnabled) {
            if (seq !== this.expectedInSeq) {
                throw new Error(`Replay Attack Detected: Received sequence ${seq}, expected exactly ${this.expectedInSeq}`);
            }
        } else {
            if (seq < this.expectedInSeq) {
                throw new Error(`Replay Attack Detected: Received sequence ${seq}, expected at least ${this.expectedInSeq}`);
            }
        }

        // Update our tracker for the next acceptable message
        this.expectedInSeq = (seq + 1) >>> 0;

        return decryptedPayloadWithSeq.subarray(4);
    }
}

/**
 * timingSafeEqual compares two strings or buffers in constant time to prevent timing attacks.
 * Since crypto.timingSafeEqual requires equal length, we hash the inputs first.
 */
function timingSafeEqual(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string') {
        if (!Buffer.isBuffer(a) || !Buffer.isBuffer(b)) {
            return a === b; // Fallback for non-string/buffer types
        }
    }

    // Hash both values to ensure they have the same length before comparison
    const hashA = crypto.createHash('sha256').update(a).digest();
    const hashB = crypto.createHash('sha256').update(b).digest();

    return crypto.timingSafeEqual(hashA, hashB);
}

module.exports = {
    CryptoStream,
    timingSafeEqual
};
