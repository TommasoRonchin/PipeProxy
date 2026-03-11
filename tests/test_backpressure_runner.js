
        const ConnectionManager = require('./client/connectionManager.js');
        const oldHandle = ConnectionManager.prototype.handleMessage;
        ConnectionManager.prototype.handleMessage = function(data) { oldHandle.call(this, data); };
        
        // Monkey patch constructor to use tiny watermarks
        const originalConstructor = ConnectionManager;
        ConnectionManager = function(...args) {
            const instance = new originalConstructor(...args);
            instance.wsHighWaterMark = 1024 * 50; // 50 KB
            instance.wsLowWaterMark = 1024 * 10;  // 10 KB
            return instance;
        };
        require('./client/raspberryClient.js');
    