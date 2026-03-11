const net = require('net');

console.log('Connecting to proxy on port 3128...');
const client = net.createConnection({ port: 3128 }, () => {
    console.log('Connected! Sending slow headers...');
    client.write('GET http://example.com/ HTTP/1.1\r\n');

    // Send one byte every 2 seconds
    const interval = setInterval(() => {
        console.log('Sending byte...');
        client.write('X-Header: ');
    }, 2000);

    setTimeout(() => {
        clearInterval(interval);
    }, 15000);
});

client.on('data', (data) => {
    console.log('Received data:', data.toString());
});

client.on('end', () => {
    console.log('Connection ended by server.');
    process.exit(0);
});

client.on('error', (err) => {
    if (err.code === 'ECONNRESET') {
        console.log('Connection reset by server (expected on timeout).');
        process.exit(0);
    } else {
        console.error('Connection error:', err.message);
        process.exit(1);
    }
});
