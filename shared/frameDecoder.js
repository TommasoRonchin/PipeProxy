const { EventEmitter } = require('events');

/**
 * FrameDecoder reconstructs frames from a continuous binary stream.
 * It emits 'frame' events with { type, connectionId, payload }
 */
class FrameDecoder extends EventEmitter {
    constructor() {
        super();
        this.chunks = [];
        this.chunkStart = 0;
        this.totalLength = 0;
        this.chunkOffset = 0; // Track offset in the first chunk instead of shifting

        const envMax = parseInt(process.env.MAX_FRAME_SIZE, 10);
        this.maxFrameSize = isNaN(envMax) ? (50 * 1024 * 1024) : envMax; // Increased to 50MB
    }

    push(chunk) {
        if (!chunk || chunk.length === 0) return;

        if (this.totalLength + chunk.length > this.maxFrameSize * 2) {
            this.emit('error', new Error(`Total decoder buffer exceeded safety limit.`));
            this._reset();
            return;
        }

        this.chunks.push(chunk);
        this.totalLength += chunk.length;
        this._processBuffer();
    }

    _reset() {
        this.chunks = [];
        this.chunkStart = 0;
        this.totalLength = 0;
        this.chunkOffset = 0;
    }

    _compactChunksIfNeeded() {
        // Compact occasionally so indexing stays O(1) without frequent Array.shift churn.
        if (this.chunkStart > 1024 && this.chunkStart * 2 > this.chunks.length) {
            this.chunks = this.chunks.slice(this.chunkStart);
            this.chunkStart = 0;
        }
    }

    _processBuffer() {
        try {
            while (this.totalLength >= 9) {
                const header = this._peek(9);
                const type = header.readUInt8(0);
                const connectionId = header.readUInt32BE(1);
                const length = header.readUInt32BE(5);

                if (length > this.maxFrameSize) {
                    this.emit('error', new Error(`Frame too large: ${length} bytes exceeds maximum allowed.`));
                    this._reset();
                    return;
                }

                if (this.totalLength >= 9 + length) {
                    this._consume(9);
                    const payload = length > 0 ? this._consume(length) : null;
                    this.emit('frame', { type, connectionId, payload });
                } else {
                    break;
                }
            }
        } catch (err) {
            this.emit('error', new Error(`Internal decoder error: ${err.message}`));
            this._reset();
        }
    }

    _peek(n) {
        if (this.totalLength < n) return Buffer.alloc(0);

        const firstChunk = this.chunks[this.chunkStart];
        const availInFirst = firstChunk.length - this.chunkOffset;

        if (availInFirst >= n) {
            return firstChunk.subarray(this.chunkOffset, this.chunkOffset + n);
        }

        const buffer = Buffer.allocUnsafe(n);
        let offset = 0;
        for (let i = this.chunkStart; i < this.chunks.length; i++) {
            const chunk = this.chunks[i];
            const start = (i === this.chunkStart) ? this.chunkOffset : 0;
            const toCopy = Math.min(chunk.length - start, n - offset);
            
            chunk.copy(buffer, offset, start, start + toCopy);
            offset += toCopy;
            if (offset === n) break;
        }

        if (offset !== n) {
            throw new Error(`Decoder Integrity Fault (Peek): Expected ${n} bytes, found ${offset}`);
        }
        return buffer;
    }

    _consume(n) {
        if (this.totalLength < n || n === 0) return Buffer.alloc(0);

        const firstChunk = this.chunks[this.chunkStart];
        const availInFirst = firstChunk.length - this.chunkOffset;

        if (availInFirst > n) {
            const result = firstChunk.subarray(this.chunkOffset, this.chunkOffset + n);
            this.chunkOffset += n;
            this.totalLength -= n;
            return result;
        } else if (availInFirst === n) {
            const result = firstChunk.subarray(this.chunkOffset);
            this.chunkStart++;
            this.chunkOffset = 0;
            this.totalLength -= n;
            this._compactChunksIfNeeded();
            return result;
        } else {
            const result = Buffer.allocUnsafe(n);
            let offset = 0;
            while (offset < n && this.chunkStart < this.chunks.length) {
                const chunk = this.chunks[this.chunkStart];
                const start = (this.chunkStart < this.chunks.length) ? this.chunkOffset : 0;
                const toCopy = Math.min(chunk.length - start, n - offset);
                
                chunk.copy(result, offset, start, start + toCopy);
                offset += toCopy;
                
                if (start + toCopy === chunk.length) {
                    this.chunkStart++;
                    this.chunkOffset = 0;
                } else {
                    this.chunkOffset += toCopy;
                }
            }

            if (offset !== n) {
                throw new Error(`Decoder Integrity Fault (Consume): Expected ${n} bytes, found ${offset}`);
            }

            this.totalLength -= n;
            this._compactChunksIfNeeded();
            return result;
        }
    }
}

module.exports = FrameDecoder;
