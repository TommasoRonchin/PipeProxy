const { EventEmitter } = require('events');

/**
 * FrameDecoder reconstructs frames from a continuous binary stream.
 * It emits 'frame' events with { type, connectionId, payload }
 */
class FrameDecoder extends EventEmitter {
    constructor() {
        super();
        this.buffer = Buffer.alloc(0);

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
        // Prevent total buffer from growing too large (Aggregation DoS Protection)
        if (this.buffer.length + chunk.length > this.maxFrameSize * 2) {
            this.emit('error', new Error(`Total decoder buffer exceeded safety limit.`));
            this.buffer = Buffer.alloc(0);
            return;
        }

        this.buffer = Buffer.concat([this.buffer, chunk]);
        this._processBuffer();
    }

    _processBuffer() {
        while (this.buffer.length >= 9) {
            // Read the 9-byte header
            const type = this.buffer.readUInt8(0);
            const connectionId = this.buffer.readUInt32BE(1);
            const length = this.buffer.readUInt32BE(5);

            // Prevent OOM Attacks (Single Frame Limit)
            if (length > this.maxFrameSize) {
                this.emit('error', new Error(`Frame too large: ${length} bytes exceeds maximum allowed of ${this.maxFrameSize} bytes.`));
                this.buffer = Buffer.alloc(0);
                return;
            }

            const totalFrameLength = 9 + length;

            if (this.buffer.length >= totalFrameLength) {
                // We have a complete frame
                const payload = length > 0 ? this.buffer.subarray(9, totalFrameLength) : null;

                // Remove frame from buffer using subarray (no copy, just pointer move)
                // We use a copy periodically or if the offset gets too large to allow GC of old chunks
                // For simplicity in this implementation, we use subarray and occasional concat cleanup
                this.buffer = this.buffer.subarray(totalFrameLength);

                this.emit('frame', { type, connectionId, payload: payload ? Buffer.from(payload) : null });
            } else {
                break;
            }
        }

        // If buffer is empty, reset to avoid holding onto a large allocated buffer through subarray
        if (this.buffer.length === 0) {
            this.buffer = Buffer.alloc(0);
        }
    }
}

module.exports = FrameDecoder;
