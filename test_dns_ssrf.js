const dns = require('dns');

dns.lookup('2130706433', (err, addr) => {
    console.log("2130706433:", err, addr);
});
dns.lookup('0177.0.0.1', (err, addr) => {
    console.log("0177.0.0.1:", err, addr);
});
dns.lookup('0x7f.0.0.1', (err, addr) => {
    console.log("0x7f.0.0.1:", err, addr);
});
