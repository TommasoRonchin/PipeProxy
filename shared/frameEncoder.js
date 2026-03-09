// Frame types
const TYPES = {
  OPEN: 1,
  DATA: 2,
  CLOSE: 3,
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
  const buffer = Buffer.alloc(9 + payloadLength);
  
  buffer.writeUInt8(type, 0);
  buffer.writeUInt32BE(connectionId, 1);
  buffer.writeUInt32BE(payloadLength, 5);
  
  if (payload && payloadLength > 0) {
    payload.copy(buffer, 9);
  }
  
  return buffer;
}

module.exports = {
  TYPES,
  encodeFrame
};
