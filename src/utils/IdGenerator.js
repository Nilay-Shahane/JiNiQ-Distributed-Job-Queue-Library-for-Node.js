const { randomUUID } = require('node:crypto');

class IdGenerator {
    // A static method means we don't have to use 'new IdGenerator()' every time
    static generate() {
        return randomUUID();
    }
}

module.exports = IdGenerator;