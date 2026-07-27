class BaseStorage {
    constructor() {
        if (this.constructor === BaseStorage) {
            throw new Error("BaseStorage is an abstract class and cannot be instantiated directly.");
        }
    }

    async fromWaitingToActive(jobJson) {
        throw new Error("Method 'fromWaitingToActive()' must be implemented.");
    }
    async checkAndUpdateHeartbeat(jobJson) {
        throw new Error("Method 'checkAndUpdateHeartbeat()' must be implemented.");
    }
    async shutdown() {
        throw new Error("Method 'shutdown()' must be implemented.");
    }
}

module.exports = BaseStorage;