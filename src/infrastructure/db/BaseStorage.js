
class BaseStorage {
    constructor() {
        if (this.constructor === BaseStorage) {
            throw new Error("BaseStorage is an abstract class and cannot be instantiated directly.");
        }
    }

    async addJobToQueue(job, opts) { 
        throw new Error("addJobToQueue() must be implemented"); 
    }
    async addBulkJobs(jobs, opts) { 
        throw new Error("addBulkJobs() must be implemented"); 
    }
    async getPayload(jobId) { 
        throw new Error("getPayload() must be implemented");
    }
    async fromWaitingToActive(opts) { 
        throw new Error("fromWaitingToActive() must be implemented"); 
    }
    async checkAndUpdateHeartbeat(ttl, jobId, workerId) { 
        throw new Error("checkAndUpdateHeartbeat() must be implemented"); 
    }
    async addToCompleted(workerId, jobId) { 
        throw new Error("addToCompleted() must be implemented"); 
    }
    async addToFailed(jobId, workerId, error) { 
        throw new Error("addToFailed() must be implemented"); 
    }
    async publishLog(jobId, status, payload, error) { 
        throw new Error("publishLog() must be implemented"); 
    }
    async sweepZombies() { 
        throw new Error("sweepZombies() must be implemented"); 
    }
    async shutdown() { 
        throw new Error("shutdown() must be implemented"); 
    }
}

module.exports = BaseStorage;