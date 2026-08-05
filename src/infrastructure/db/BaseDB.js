class BaseDB {
    constructor() {
        if (this.constructor === BaseDB) {
            throw new Error("BaseDB is an abstract class and cannot be instantiated directly.");
        }
    }
    
    async run(command, ...args) { throw new Error("run() must be implemented"); }
    pipeline() { throw new Error("pipeline() must be implemented"); }
    async disconnect() { throw new Error("disconnect() must be implemented"); }
}

module.exports = BaseDB;