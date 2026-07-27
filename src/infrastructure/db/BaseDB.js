/**
 * BaseDB - Abstract Interface for JiNiQ Storage Engines
 * Ensuring consistency across different database implementations.
 */
class BaseDB {
    constructor() {
        if (this.constructor === BaseDB) {
            throw new Error("BaseDB is an abstract class and cannot be instantiated directly.");
        }
    }
    async maxRetriesDbConnect(times) {
        throw new Error("Method 'maxRetriesDbConnect()' must be implemented.");
    }

    async fromWaitingToActive(jobJson) {
        throw new Error("Method 'fromWaitingToActive()' must be implemented.");
    }

    
    
}
module.exports = BaseDB;