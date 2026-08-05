const { EventEmitter } = require("events");
const JobSubmitted = require("../domain/events/JobSubmitted");
const Job = require("../domain/Job");
const IdGenerator = require("../utils/IdGenerator");

// The Queue now imports its own infrastructure
const RedisDB = require("../infrastructure/db/RedisDB");
const RedisStorage = require("../infrastructure/db/RedisStorage");

class Jiniq extends EventEmitter {
    // 1. We use '#' to make these strictly private. The user CANNOT access them!
    #queueName;
    #storageInstance;
    #maxQueueSize;
    #bulkChunkSize;
    #priorityOffset;

    constructor(queueName, options = {}) {
        super(); 
       if (!queueName || typeof queueName !== 'string' || queueName.trim() === '') {
            throw new Error("Jiniq: A valid string queueName is required to initialize.");
        }
        
        this.#queueName = queueName.trim();
        this.#maxQueueSize = options.maxQueueSize || 0;
        this.#priorityOffset = options.priorityOffset ?? 10000;
        this.#bulkChunkSize = options.bulkChunkSize || 1000;


        const redisConfig = options.redisConfig || {};
        const managerInstance = new RedisDB(redisConfig);
        const fetcherInstance = new RedisDB(redisConfig);
        
        this.#storageInstance = new RedisStorage(
            this.#queueName, 
            managerInstance, 
            fetcherInstance, 
            redisConfig
        );
    }

    async addJob(jobName, payload = {}, options = {}) {
        if (!jobName || typeof jobName !== 'string') {
            throw new TypeError("Jiniq: jobName must be a valid string.");
        }
        
        

        const payloadString = JSON.stringify(payload);
        const payloadSize = Buffer.byteLength(payloadString, 'utf8');
        if (payloadSize > 1024 * 1024) { 
            throw new Error(`PayloadTooLargeError: Payload is ${(payloadSize/1024/1024).toFixed(2)}MB. Limit is 1MB.`);
        }
        const jobId = options.jobId || IdGenerator.generate();
        const job = new Job({
            id: jobId,
            name: jobName,
            payload,
            ...options
        });

        const serializedJob = job.toRedisHash();
        
        // We access our strictly private storage instance
        const result = await this.#storageInstance.addJobToQueue(serializedJob, { maxQueueSize: this.#maxQueueSize, priorityOffset: this.#priorityOffset });

        if (result === 0) {
            console.warn(`[Jiniq Warning] Job with ID ${jobId} already exists. Skipping duplicate insertion.`);
            return job; 
        }

        const jobSubmittedEvent = JobSubmitted.fromJob(job);
        this.emit("job:submitted", jobSubmittedEvent);
        return job;
    }

    async addBulk(jobsArray) {
        if (!Array.isArray(jobsArray) || jobsArray.length === 0) {
            throw new Error("jobsArray must be a non-empty array");
        }

        const serializedJobs = [];
        const domainJobs = [];

        for (const item of jobsArray) {
            if (!item.name || typeof item.name !== 'string') {
                throw new TypeError("Jiniq: Each bulk job must have a valid string name.");
            }
            const payloadString = JSON.stringify(item.payload || {});
            if (Buffer.byteLength(payloadString, 'utf8') > 1024 * 1024) {
                throw new Error(`PayloadTooLargeError: Bulk job "${item.name}" exceeds 1MB limit. Bulk operation aborted.`);
            }

            const jobId = (item.options && item.options.jobId) ? item.options.jobId : IdGenerator.generate();
            
            const job = new Job({
                id: jobId,
                name: item.name,
                payload: item.payload || {},
                ...item.options
            });
            
            domainJobs.push(job);
            serializedJobs.push(job.toRedisHash());
        }
        const result = await this.#storageInstance.addBulkJobs(serializedJobs, { 
            maxQueueSize: this.#maxQueueSize,
            chunkSize: this.#bulkChunkSize ,
            priorityOffset: this.#priorityOffset
        });

        this.emit("jobs:submitted:bulk", { 
            count: result.successCount, 
            failedCount: result.failedCount,
            failedJobs: result.failedJobs 
        });

        return { ...result, jobs: domainJobs };
    }

    async close() {
        await this.#storageInstance.shutdown();
    }
}

module.exports = Jiniq;