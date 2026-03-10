const TYPES = {
    OPEN: 1,
    DATA: 2,
    CLOSE: 3,
    PING: 4,
    PONG: 5,
    OPEN_ACK: 6,
};

/**
 * Encodes a frame into a binary buffer.
 * Frame format:
 * | type (1 byte) | connectionId (4 bytes) | length (4 bytes) | payload |
 *
 * @param {number} type 1=OPEN, 2=DATA, 3=CLOSE
 * @param {number} connectionId The stream ID
 * @param {Buffer} payload Optional payload data
 * @returns {Buffer} The encoded frame
 */
function encodeFrame(type, connectionId, payload = null) {
    const payloadLength = payload ? payload.length : 0;

    const envMaxMb = parseInt(process.env.MAX_ENCODE_FRAME_SIZE_MB, 10);
    const maxEncodeSize = isNaN(envMaxMb) ? (50 * 1024 * 1024) : (envMaxMb * 1024 * 1024);

    // Safety guard against ridiculous buffer allocations leading to OOM (Denial of Service)
    if (payloadLength > maxEncodeSize) {
        throw new Error(`[FrameEncoder] CRITICAL: Attempted to encode a frame exceeding ${maxEncodeSize / (1024 * 1024)}MB limit (${payloadLength} bytes). Payload rejected to prevent OOM.`);
    }

    const buffer = Buffer.alloc(9 + payloadLength);

    buffer.writeUInt8(type, 0);
    buffer.writeUInt32BE(connectionId, 1);
    buffer.writeUInt32BE(payloadLength, 5);

    if (payload && payloadLength > 0) {
        payload.copy(buffer, 9);
    }

    return buffer;
}

/**
 * Safely redacts Proxy-Authorization headers from a binary buffer
 * without corrupting binary data using latin1 interpretation.
 * 
 * @param {Buffer} buffer The buffer to redact
 * @returns {Buffer} A new buffer or the same buffer if modified (depending on implementation, here we return a copy if modified)
 */
function redactProxyAuth(buffer) {
    if (!buffer || buffer.length < 20) return buffer;

    const latin1Str = buffer.toString('latin1').toLowerCase();
    if (!latin1Str.includes('proxy-authorization:')) {
        return buffer;
    }

    // Work on a copy to avoid side-effects on shared buffers
    const processed = Buffer.from(buffer);
    let searchIdx = 0;
    while (true) {
        const idx = latin1Str.indexOf('proxy-authorization:', searchIdx);
        if (idx === -1) break;

        let endIdx = latin1Str.indexOf('\r\n', idx);
        if (endIdx === -1) endIdx = latin1Str.length;

        // Overwrite with spaces
        for (let i = idx; i < endIdx; i++) {
            processed[i] = 0x20;
        }
        searchIdx = endIdx + 2;
    }
    return processed;
}

module.exports = {
    TYPES,
    encodeFrame,
    redactProxyAuth
};
