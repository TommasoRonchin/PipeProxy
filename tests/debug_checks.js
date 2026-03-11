const crypto = require('crypto');

function timingSafeEqual(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string') {
        if (!Buffer.isBuffer(a) || !Buffer.isBuffer(b)) {
            return a === b;
        }
    }
    const hashA = crypto.createHash('sha256').update(a).digest();
    const hashB = crypto.createHash('sha256').update(b).digest();
    return crypto.timingSafeEqual(hashA, hashB);
}

console.log('Test 1 (same strings):', timingSafeEqual('test', 'test'));
console.log('Test 2 (diff strings):', timingSafeEqual('test', 'wrong'));
console.log('Test 3 (undefined):', timingSafeEqual(undefined, undefined));

const ipaddr = require('ipaddr.js');
function isProtectedIP(ipString) {
    try {
        const addr = ipaddr.parse(ipString);
        const range = addr.range();
        const blockedRanges = ['unspecified', 'broadcast', 'multicast', 'linkLocal', 'loopback', 'private', 'reserved', 'carrierGradeNat', 'uniqueLocal', 'ipv4Mapped'];
        if (blockedRanges.includes(range)) return true;
        if (range === 'ipv4Mapped' && addr.kind() === 'ipv6') {
            const mappedIPv4 = addr.toIPv4Address();
            if (blockedRanges.includes(mappedIPv4.range())) return true;
        }
        return false;
    } catch (e) { return true; }
}

console.log('IP 127.0.0.1 protected:', isProtectedIP('127.0.0.1'));
console.log('IP ::1 protected:', isProtectedIP('::1'));
console.log('IP ::ffff:127.0.0.1 protected:', isProtectedIP('::ffff:127.0.0.1'));
console.log('IP 8.8.8.8 protected:', isProtectedIP('8.8.8.8'));
