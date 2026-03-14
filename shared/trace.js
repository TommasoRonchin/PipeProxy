const { performance } = require('perf_hooks');
const fs = require('fs');
const path = require('path');

const LOG_FILE = path.join(process.cwd(), 'trace.log');

class Tracer {
    constructor(name) {
        this.name = name;
        this.counters = new Map();
        this.lastPrint = performance.now();
        this.enabled = process.env.ENABLE_TRACING === 'true';

        if (this.enabled) {
            setInterval(() => {
                const msg = `[ALIVE-${this.name}] ${new Date().toISOString()}\n`;
                fs.appendFileSync(LOG_FILE, msg);
                this.print();
            }, 1000);
        }
    }

    trace(event, bytes = 0) {
        if (!this.enabled) return;
        const current = this.counters.get(event) || 0;
        this.counters.set(event, current + bytes);
    }

    print() {
        const now = performance.now();
        const dt = (now - this.lastPrint) / 1000;
        if (dt <= 0) return;
        
        let msg = `[TRACE-${this.name}] `;
        for (const [event, total] of this.counters.entries()) {
            const speed = (total / 1024 / 1024 / dt).toFixed(2);
            msg += `${event}: ${speed}MB/s `;
            this.counters.set(event, 0); // reset for next interval
        }

        const mem = process.memoryUsage();
        const memStr = `RSS: ${(mem.rss/1024/1024).toFixed(0)}MB Heap: ${(mem.heapUsed/1024/1024).toFixed(0)}MB Ext: ${(mem.external/1024/1024).toFixed(0)}MB`;
        
        fs.appendFileSync(LOG_FILE, msg + ` | ${memStr}\n`);
        this.lastPrint = now;
    }
}

module.exports = Tracer;
