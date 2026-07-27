const BaseStorage = require('./BaseStorage')
const RedisDB = require('./RedisDB')

class RedisStorage extends BaseStorage {
    constructor(nameOfQ, ManagerInstance, FetcherInstance, config = {}) {
        super()
        this.keyMap = {
            main: `jiniq:${nameOfQ}:main`,
            priority: `jiniq:${nameOfQ}:priority`,
            normal: `jiniq:${nameOfQ}:normal`,
            active: `jiniq:${nameOfQ}:active`,
            lock: `jiniq:${nameOfQ}:lock`,
            complete: `jiniq:${nameOfQ}:complete`,
            delay: `jiniq:${nameOfQ}:delay`,
            dead: `jiniq:${nameOfQ}:dead`,
            notify: `jiniq:${nameOfQ}:notify`,
        }
        
        this.manager = ManagerInstance
        this.fetcher = FetcherInstance
    }

 async getPayload(jobId) {
        const payloadStr = await this.manager.client.hget(`${this.keyMap.main}:${jobId}`, 'payload');
        try {
            // Turn the string back into a usable object!
            return payloadStr ? JSON.parse(payloadStr) : null;
        } catch (e) {
            return payloadStr; // Fallback in case it wasn't a JSON object
        }
    }

    async addJobToQueue(serializedJob, options = {}) {
        const jobId = serializedJob.id;
        const jobKey = `${this.keyMap.main}:${jobId}`;
        const keys = [
            jobKey,
            this.keyMap.priority,
            this.keyMap.normal,
            this.keyMap.delay,
            this.keyMap.notify
        ];
        const hashArgs = [];
        for (const [key, value] of Object.entries(serializedJob)) {
            let strValue;
            if (value == null) {
                strValue = " ";
            } else if (typeof value === 'object') {
                strValue = JSON.stringify(value); // Safely convert nested objects to strings
            } else {
                strValue = value.toString();
            }
            hashArgs.push(key, strValue);
        }
        
        const timestamp = Date.now();
        const priorityOffset = 10000;
        const maxQueueSize = options.maxQueueSize || 0;

        const args = [
            jobId,
            serializedJob.priority || "normal",
            serializedJob.delay || 0,
            timestamp,
            priorityOffset,
            maxQueueSize,
            ...hashArgs
        ];
           
        const result = await this.manager.run('addJobtoQueue', ...keys, ...args);

        if (result === -1) {
            throw new Error(`QueueFullError: Cannot add job. The queue "${this.keyMap.main}" has reached its maximum capacity of ${maxQueueSize}.`);
        }
        if (result !== 1 && result !== 0) {
            throw new Error(`UnknownError: Lua script returned unexpected code ${result}`);
        }
        
        return result;
    }

    async addBulkJobs(serializedJobsArray, options = {}) {
        const CHUNK_SIZE = options.chunkSize || 1000; 
        let successCount = 0;
        let failedCount = 0;
        const failedJobs = [];

        const timestamp = Date.now();
        const priorityOffset = 10000;
        const maxQueueSize = options.maxQueueSize || 0;

        for (let i = 0; i < serializedJobsArray.length; i += CHUNK_SIZE) {
            const chunk = serializedJobsArray.slice(i, i + CHUNK_SIZE);
            const pipeline = this.manager.pipeline();
            
            for (const serializedJob of chunk) {
                const jobId = serializedJob.id;
                const jobKey = `${this.keyMap.main}:${jobId}`;
                const keys = [
                    jobKey, 
                    this.keyMap.priority, 
                    this.keyMap.normal, 
                    this.keyMap.delay, 
                    this.keyMap.notify
                ];
                
                const hashArgs = [];
        for (const [key, value] of Object.entries(serializedJob)) {
            let strValue;
            if (value == null) {
                strValue = " ";
            } else if (typeof value === 'object') {
                strValue = JSON.stringify(value); // Safely convert nested objects to strings
            } else {
                strValue = value.toString();
            }
            hashArgs.push(key, strValue);
        }

                const args = [
                    jobId,
                    serializedJob.priority || "normal", 
                    serializedJob.delay || 0,
                    timestamp,
                    priorityOffset,
                    maxQueueSize,
                    ...hashArgs
                ];

                pipeline.addJobtoQueue(...keys, ...args);
            }

            const pipelineResults = await pipeline.exec();

            pipelineResults.forEach(([err, result], index) => {
                const originalJobId = chunk[index].id;

                if (err) {
                    failedCount++;
                    failedJobs.push({ id: originalJobId, reason: err.message });
                } else {
                    switch (result) {
                        case 1: // Standard success
                        case 0: // Idempotent success (already exists)
                            successCount++;
                            break;
                        case -1: // Known error: Queue Full
                            failedCount++;
                            failedJobs.push({ id: originalJobId, reason: 'QueueFullError: Reached max capacity' });
                            break;
                        default: // Unknown/Future error codes
                            failedCount++;
                            failedJobs.push({ id: originalJobId, reason: `UnknownError: Lua script returned unexpected code ${result}` });
                            break;
                    }
                }
            });
        }

        return {
            totalAttempted: serializedJobsArray.length,
            successCount,
            failedCount,
            failedJobs
        };
    }
    
    async fromWaitingToActive(jobJson) {
        const { ttl = 30000, priorityOffset = 10000, workerId } = jobJson

        const keys = [
            this.keyMap.priority,
            this.keyMap.normal, 
            this.keyMap.active,
            this.keyMap.lock,
            this.keyMap.delay // Added this 5th key for the Lua script
        ];

        const timestamp = Date.now();

        return await this.fetcher.run(
            'claimNextJob',
            ...keys,
            ttl,
            timestamp,
            priorityOffset,
            workerId
        );
    }

    async checkAndUpdateHeartbeat(heartbeat, jobId, workerId) {
        const keys = [
            this.keyMap.lock
        ]

        return await this.manager.run(
            'renewJobLease',
            ...keys,
            jobId,
            workerId,
            heartbeat
        )
    }

    async addToCompleted(workerId, jobId) {
        const keys = [
            this.keyMap.lock,
            this.keyMap.active,
            this.keyMap.complete
        ]
        const jobKey = `${this.keyMap.main}:${jobId}`

        return await this.manager.run(
            'checkAndComplete',
            ...keys,
            jobId,
            workerId,
            jobKey
        )
    }

    async addToFailed(jobId, workerId, error) {
        const keys = [
            this.keyMap.lock,
            this.keyMap.active,
            this.keyMap.delay,
            this.keyMap.dead
        ];

        const jobKey = `${this.keyMap.main}:${jobId}`;

        const errorMessage =
            error instanceof Error
                ? (error.stack || error.message)
                : String(error ?? "");

        return await this.manager.run(
            "addToDelayedOrDead",
            ...keys,
            jobId,
            workerId,
            jobKey,
            errorMessage
        );
    }

   async publishLog(jobId, status, payload, error = null) {
    const queueName = this.keyMap.main.split(':')[1];
    const streamKey = `jiniq:${queueName}:logs`;

    const payloadStr =
        typeof payload === "object"
            ? JSON.stringify(payload)
            : String(payload);

    await this.manager.client.xadd(
        streamKey,
        "MAXLEN", "~", 1000,   // Keep roughly the latest 10k logs
        "*",
        "jobId", jobId,
        "status", status,
        "payload", payloadStr,
        "timestamp", Date.now().toString(),
        "error", error ? String(error) : ""
    );
}
    async sweepZombies() {
        const keys = [
            this.keyMap.active,
            this.keyMap.delay,
            this.keyMap.dead
        ];

        return await this.manager.run(
            'sweeper',
            ...keys,
            this.keyMap.lock,
            this.keyMap.main
        );
    }

    async shutdown() {
        await Promise.all([
            this.manager.disconnect(),
            this.fetcher.disconnect()
        ]);
    }
}

module.exports = RedisStorage