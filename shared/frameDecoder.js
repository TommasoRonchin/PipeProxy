const { EventEmitter } = require('events');

/**
 * FrameDecoder reconstructs frames from a continuous binary stream.
 * It emits 'frame' events with { type, connectionId, payload }
 */
class FrameDecoder extends EventEmitter {
    constructor() {
        super();
        this.chunks = [];
        this.totalLength = 0;

        // Configurable Maximum Frame Size to prevent OOM DOS attacks
        const envMax = parseInt(process.env.MAX_FRAME_SIZE, 10);
        this.maxFrameSize = isNaN(envMax) ? (10 * 1024 * 1024) : envMax; // Default 10MB
    }

    /**
     * Pushes incoming data chunks to the decoder.
     * Parses as many frames as possible and emits them.
     * @param {Buffer} chunk 
     */
    push(chunk) {
        if (!chunk || chunk.length === 0) return; // Ignore empty chunks

        // Prevent total buffer from growing too large (Aggregation DoS Protection)
        if (this.totalLength + chunk.length > this.maxFrameSize * 2) {
            this.emit('error', new Error(`Total decoder buffer exceeded safety limit.`));
            this.chunks = [];
            this.totalLength = 0;
            return;
        }

        this.chunks.push(chunk);
        this.totalLength += chunk.length;
        this._processBuffer();
    }

    _processBuffer() {
        try {
            while (this.totalLength >= 9) {
                // Read the 9-byte header without concatenating everything
                const header = this._peek(9);
                const type = header.readUInt8(0);
                const connectionId = header.readUInt32BE(1);
                const length = header.readUInt32BE(5);

                // Prevent OOM Attacks (Single Frame Limit)
                if (length > this.maxFrameSize) {
                    this.emit('error', new Error(`Frame too large: ${length} bytes exceeds maximum allowed of ${this.maxFrameSize} bytes.`));
                    this.chunks = [];
                    this.totalLength = 0;
                    return;
                }

                const totalFrameLength = 9 + length;

                if (this.totalLength >= totalFrameLength) {
                    // We have a complete frame. Consume header + payload.
                    this._consume(9); 
                    const payload = length > 0 ? this._consume(length) : null;

                    this.emit('frame', { type, connectionId, payload });
                } else {
                    break;
                }
            }
        } catch (err) {
            this.emit('error', new Error(`Internal decoder error: ${err.message}`));
            this.chunks = [];
            this.totalLength = 0;
        }
    }

    /**
     * Internal helper to peek N bytes from the chunk list WITHOUT consuming them.
     */
    _peek(n) {
        if (this.chunks.length === 0) return Buffer.alloc(0);

        if (this.chunks[0].length >= n) {
            return this.chunks[0].subarray(0, n);
        }
        
        // Data spans multiple chunks, need a temporary buffer
        const buffer = Buffer.allocUnsafe(n);
        let offset = 0;
        for (const chunk of this.chunks) {
            const toCopy = Math.min(chunk.length, n - offset);
            if (toCopy > 0) {
                chunk.copy(buffer, offset, 0, toCopy);
                offset += toCopy;
            }
            if (offset === n) break;
        }
        
        if (offset !== n) {
            throw new Error(`Decoder Integrity Fault (Peek): Expected ${n} bytes, only found ${offset}`);
        }
        return buffer;
    }

    /**
     * Internal helper to consume (and remove) N bytes from the chunk list.
     */
    _consume(n) {
        if (this.chunks.length === 0 || n === 0) return Buffer.alloc(0);

        let result;
        if (this.chunks[0].length > n) {
            // Case 1: Subarray of the first chunk
            result = Buffer.from(this.chunks[0].subarray(0, n));
            this.chunks[0] = this.chunks[0].subarray(n);
        } else if (this.chunks[0].length === n) {
            // Case 2: Exactly the first chunk
            result = this.chunks.shift();
        } else {
            // Case 3: Spans multiple chunks
            result = Buffer.allocUnsafe(n);
            let offset = 0;
            while (offset < n && this.chunks.length > 0) {
                const chunk = this.chunks[0];
                const toCopy = Math.min(chunk.length, n - offset);
                chunk.copy(result, offset, 0, toCopy);
                offset += toCopy;
                
                if (toCopy === chunk.length) {
                    this.chunks.shift();
                } else {
                    this.chunks[0] = chunk.subarray(toCopy);
                }
            }

            if (offset !== n) {
                throw new Error(`Decoder Integrity Fault (Consume): Expected ${n} bytes, only found ${offset}. State corrupted.`);
            }
        }
        this.totalLength -= n;
        return result;
    }
}

module.exports = FrameDecoder;
