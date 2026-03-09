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
        this.buffer = Buffer.concat([this.buffer, chunk]);
        this._processBuffer();
    }

    _processBuffer() {
        while (this.buffer.length >= 9) {
            // Read the 9-byte header
            const type = this.buffer.readUInt8(0);
            const connectionId = this.buffer.readUInt32BE(1);
            const length = this.buffer.readUInt32BE(5);

            // Prevent OOM Attacks
            if (length > this.maxFrameSize) {
                this.emit('error', new Error(`Frame too large: ${length} bytes exceeds maximum allowed of ${this.maxFrameSize} bytes.`));
                this.buffer = Buffer.alloc(0); // clear buffer to prevent further parsing attempts on corrupt data
                return;
            }

            const totalFrameLength = 9 + length;

            if (this.buffer.length >= totalFrameLength) {
                // We have a complete frame
                let payload = null;
                if (length > 0) {
                    payload = Buffer.alloc(length);
                    this.buffer.copy(payload, 0, 9, totalFrameLength);
                }

                // Remove frame from buffer
                this.buffer = this.buffer.subarray(totalFrameLength);

                this.emit('frame', { type, connectionId, payload });
            } else {
                // Incomplete frame, wait for more data
                break;
            }
        }
    }
}

module.exports = FrameDecoder;
