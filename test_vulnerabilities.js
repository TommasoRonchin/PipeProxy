const ConnectionManager = require('./client/connectionManager');
const FrameProtocol = require('./server/frameProtocol');
const { TYPES } = require('./shared/frameEncoder');
const { EventEmitter } = require('events');
const { CryptoStream } = require('./shared/cryptoStream');
const mockCrypto = new CryptoStream({ enableEncryption: false });

console.log('--- Testing Null/Empty Data Payloads ---');
try {
    const mockWs = new EventEmitter();
    mockWs.send = () => { };
    mockWs.readyState = 1;

    // Test Client
    const manager = new ConnectionManager(mockWs, mockCrypto);
    manager.handleFrame({ type: TYPES.OPEN, connectionId: 1, payload: Buffer.from('google.com:80') });
    manager.handleFrame({ type: TYPES.DATA, connectionId: 1, payload: null });
    manager.handleFrame({ type: TYPES.DATA, connectionId: 1, payload: Buffer.alloc(0) });
    console.log('✅ ConnectionManager ignored empty payload without crashing.');

    // Test Server
    const mockTunnelServer = new EventEmitter();
    mockTunnelServer.sendFrame = () => { };
    mockTunnelServer.isReady = () => true;

    const protocol = new FrameProtocol(mockTunnelServer);
    // Force inject a mock socket
    const mockSocket = new EventEmitter();
    mockSocket.write = (data) => {
        if (!data || data.length === 0) throw new TypeError('Cannot write null or empty data');
        return true;
    };
    mockSocket.end = () => { };
    mockSocket.destroy = () => { };
    protocol.connections.set(1, mockSocket);

    protocol.handleIncomingFrame({ type: TYPES.DATA, connectionId: 1, payload: null });
    protocol.handleIncomingFrame({ type: TYPES.DATA, connectionId: 1, payload: Buffer.alloc(0) });
    console.log('✅ FrameProtocol ignored empty payload without crashing.');

} catch (e) {
    console.error('❌ Crash on empty data:', e.message);
    process.exit(1);
}

console.log('\n--- Testing DNS Abort Ghost Connection ---');
const mockWs2 = new EventEmitter();
mockWs2.send = () => { };
mockWs2.readyState = 1;

const manager2 = new ConnectionManager(mockWs2, mockCrypto);
// Initiate an OPEN frame which triggers dns.lookup
manager2.handleFrame({ type: TYPES.OPEN, connectionId: 2, payload: Buffer.from('google.com:443') });
// Immediately send CLOSE to simulate an aborted connection before DNS finishes
manager2.handleFrame({ type: TYPES.CLOSE, connectionId: 2 });

// Wait for DNS lookup (which is async) to finish and call callback
setTimeout(() => {
    if (manager2.connections.has(2)) {
        console.error('❌ Ghost connection was created (memory leak!).');
        process.exit(1);
    } else {
        console.log('✅ Aborted connection was properly dropped, no ghost socket created.');
        console.log('\n✅ All Security Patch tests completed successfully!');
        process.exit(0);
    }
}, 3000);
