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
        const sessionNonce = options.sessionNonce || '';
        this.key = crypto.createHash('sha256').update((secret || 'fallback_for_disabled_encryption') + sessionNonce).digest();

        // Replay attack prevention: sequence numbers per instance
        this.outSeq = 0;
        this.expectedInSeq = 0;

        // Pre-allocate sequence buffer to avoid per-message allocation
        this.seqBuffer = Buffer.allocUnsafe(4);
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

        const payloadLength = buffer.length;
        // Total size: IV(12) + Tag(16) + CipherText(Seq(4) + payloadLength)
        const outBuffer = Buffer.allocUnsafe(12 + 16 + payloadLength + 4);
        
        // 1. Generate IV directly into the output buffer
        const iv = outBuffer.subarray(0, 12);
        crypto.randomFillSync(iv);

        const cipher = crypto.createCipheriv('aes-256-gcm', this.key, iv);

        // 2. Setup Sequence Number
        this.seqBuffer.writeUInt32BE(this.outSeq, 0);
        this.outSeq = (this.outSeq + 1) >>> 0;

        // 3. Encrypt: Sequence + Payload
        // We use a small optimization here: update with sequence, then update with buffer
        let offset = 28;
        const c1 = cipher.update(this.seqBuffer);
        if (c1.length > 0) {
            c1.copy(outBuffer, offset);
            offset += c1.length;
        }

        const c2 = cipher.update(buffer);
        if (c2.length > 0) {
            c2.copy(outBuffer, offset);
            offset += c2.length;
        }

        const cf = cipher.final();
        if (cf.length > 0) {
            cf.copy(outBuffer, offset);
            offset += cf.length;
        }

        // Verify that we haven't leaked any uninitialized memory in outBuffer
        if (offset !== outBuffer.length) {
             throw new Error(`CRITICAL: Encryption length mismatch. Expected ${outBuffer.length}, got ${offset}`);
        }

        // 4. Get Auth Tag and put it in its place (offset 12)
        const authTag = cipher.getAuthTag();
        authTag.copy(outBuffer, 12);

        return outBuffer;
    }

    decryptMessage(buffer) {
        if (!this.isEncryptionEnabled) return buffer;

        // GCM Payload structure: [ IV (12) ][ AuthTag (16) ][ CipherText ]
        if (buffer.length < 28) {
            throw new Error('Encrypted payload too short to contain IV and AuthTag');
        }

        // Extract IV (12 bytes), AuthTag (16 bytes) and the encrypted data using subarrays (no copy)
        const iv = buffer.subarray(0, 12);
        const authTag = buffer.subarray(12, 28);
        const encrypted = buffer.subarray(28);

        const decipher = crypto.createDecipheriv('aes-256-gcm', this.key, iv);
        decipher.setAuthTag(authTag);

        const decryptedPayloadWithSeq = Buffer.concat([decipher.update(encrypted), decipher.final()]);

        // Extract and verify Sequence Number
        if (decryptedPayloadWithSeq.length < 4) {
            throw new Error('Encrypted payload missing sequence number');
        }

        const seq = decryptedPayloadWithSeq.readUInt32BE(0);
        const diff = (seq - this.expectedInSeq) >>> 0;

        if (this.isStrictSequenceEnabled) {
            if (diff !== 0) {
                throw new Error(`Replay Attack Detected: Received sequence ${seq}, expected exactly ${this.expectedInSeq}`);
            }
        } else {
            if (diff > 2147483647) {
                throw new Error(`Replay Attack Detected: Received sequence ${seq}, expected at least ${this.expectedInSeq}`);
            }
        }

        this.expectedInSeq = (diff === 0 || this.isStrictSequenceEnabled)
            ? ((this.expectedInSeq + 1) >>> 0)
            : ((seq + 1) >>> 0);

        return decryptedPayloadWithSeq.subarray(4);
    }
}

/**
 * timingSafeEqual compares two strings or buffers in constant time to prevent timing attacks.
 * Since crypto.timingSafeEqual requires equal length, we hash the inputs first.
 */
function timingSafeEqual(a, b) {
    // Prevent crashes if inputs are undefined or null (e.g. missing auth headers)
    if (a === undefined || a === null || b === undefined || b === null) {
        return a === b;
    }

    if (typeof a !== 'string' || typeof b !== 'string') {
        if (!Buffer.isBuffer(a) || !Buffer.isBuffer(b)) {
            // If they are different types and not both buffers/strings, they can't be equal
            if (typeof a !== typeof b) return false;
            return a === b; // Fallback for other identical types (numbers, etc)
        }
    }

    // Hash both values to ensure they have the same length before comparison
    // This allows comparing strings of different lengths safely
    const hashA = crypto.createHash('sha256').update(a).digest();
    const hashB = crypto.createHash('sha256').update(b).digest();

    return crypto.timingSafeEqual(hashA, hashB);
}

module.exports = {
    CryptoStream,
    timingSafeEqual
};
