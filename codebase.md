# JiNiQ Codebase

This file contains only the source and test code for JiNiQ (docs/README excluded).

## Directory Structure

```
src/
  domain/
    events/
      BaseEvent.js
      JobSubmitted.js
    Job.js
    JobStatus.js
  infrastructure/
    db/
      BaseDB.js
      BaseStorage.js
      RedisDB.js
      RedisFactory.js
      RedisStorage.js
    lua/
      AddJobLua.lua
      AddToDelayedOrDeadLua.lua
      CheckAndComplete.lua
      CheckAndUpdateHeartbeat.lua
      ClaimNextJob.lua
      Sweeper.lua
  queue/
    Jiniq.js
  utils/
    IdGenerator.js
  worker/
    Heartbeat.js
    JobExecutor.js
    Supervisor.js
    Sweeper.js
    Worker.js
  index.js
  test.js
  worker_crash_test.js
test/
  happy-path/
    producer_hp.js
    worker_hp.js
  heartbeat-failure-normal/
    producer.js
    workerA.js
    workerB.js
  process-crash/
    producer_pc.js
    worker_pc.js
  worker-blip/
    producer_wb.js
    worker_wb.js
  zombie-worker/
    producer_zw.js
    workerA_zw.js
    workerB_zw.js
package.json
```

---

## src/index.js

```javascript
const Jiniq = require("./queue/Jiniq");
const Worker = require("./worker/Worker");

module.exports = {
    Jiniq,
    Worker
};
```

## src/test.js

```javascript
const Jiniq = require('./queue/Jiniq'); // Adjust this if your export is different
const JiniqWorker = require('./worker/Worker'); // Adjust this if your export is different

async function runChaosTest() {
    console.log("🌪️ Starting the Chaos Test...");
    
    // Assuming your Jiniq class is instantiated like this
    const emailQueue = new Jiniq('email-queue');

    // 1. Flood the queue with jobs (Passing the jobName as the first string argument!)
    console.log("📦 Pushing jobs to the waitlist...");
    
    await emailQueue.addJob("send_welcome", { type: "welcome", to: "user1@test.com", action: "success" });
    await emailQueue.addJob("send_invoice", { type: "invoice", to: "user2@test.com", action: "slow" });
    await emailQueue.addJob("send_alert",   { type: "alert", to: "admin@test.com", action: "crash" });
    await emailQueue.addJob("send_report",  { type: "report", to: "boss@test.com", action: "timeout" });
    await emailQueue.addJob("send_digest",  { type: "digest", to: "user3@test.com", action: "success" });

    // 2. Define a chaotic processing function
    const chaoticProcessor = async (payload) => {
        console.log(`\n⚙️ Processing job: ${payload.action}`);

        if (payload.action === 'success') {
            return "Email sent successfully!";
        }
        
        if (payload.action === 'slow') {
            // Wait 4 seconds to force the dashboard to show it as 'Active'
            await new Promise(resolve => setTimeout(resolve, 4000));
            return "Email sent, but it took a while.";
        }

        if (payload.action === 'crash') {
            // Intentionally throw an error to test the Failed state and stack trace
            throw new Error("SMTP_CONNECTION_REFUSED: Could not connect to mail server on port 587.");
        }

        if (payload.action === 'timeout') {
            // Intentionally hang for 15 seconds (assuming your maxTimeoutMs is around 5-10s)
            await new Promise(resolve => setTimeout(resolve, 15000));
            return "This will never be reached because Jiniq will kill it first.";
        }
    };

    // 3. Start the worker to consume the jobs
    console.log("👷 Starting worker...");
    
    // Make sure this matches your worker's constructor signature!
    const worker = new JiniqWorker('email-queue', chaoticProcessor, {
        maxTimeoutMs: 5000 
    });

    worker.start();
}

runChaosTest();
```

## src/worker_crash_test.js

```javascript
const Jiniq = require('./queue/Jiniq');
const Worker = require('./worker/Worker');

async function runRealWorldRetryDemo() {
    const queueName = 'email-notifications';

    // 1. Initialize the Queue (Producer)
    const queue = new Jiniq(queueName);

    // 2. Setup the Worker (Consumer)
    // We use a Map to simulate a "flaky" third-party API that fails the first time 
    // it sees a specific job, but succeeds the second time.
    const failureTracker = new Map();

    const worker = new Worker(queueName, async (job) => {
        console.log(`[Worker] Picked up Job ID: ${job.id}`);

        // Track how many times we've tried this specific job
        const attempts = failureTracker.get(job.id) || 0;
        
        if (attempts === 0) {
            failureTracker.set(job.id, 1);
            console.log(`[Worker] Simulating API connection drop for Job ${job.id}...`);
            
            // USER POV: The developer's code just throws a standard JavaScript error.
            // They don't need to know about Redis, Lua, or Sweepers.
            throw new Error("Connection reset by peer (SendGrid API)");
        }

        console.log(`[Worker] Attempt #2 for Job ${job.id} - Sending email successfully!`);
        
        // Simulate some async work
        await new Promise(resolve => setTimeout(resolve, 300));
        
        console.log(`[Worker] Job ${job.id} Completed.`);
    }, {
        concurrency: 1 
    });

    // Listen to worker events
    worker.on('job:completed', (data) => console.log(`[Event] Job Completed: ${data.jobId}`));
    worker.on('job:failed', (data) => console.log(`[Event] Job Failed/Retrying: ${data.jobId}`));

    // Start listening
    await worker.start();

    // 3. Producer adds the job
    // We do NOT pass a jobId. We let IdGenerator.generate() do its job.
    // We DO pass maxAttempts to tell JiNiQ to retry it.
    console.log(`[Producer] Adding job to queue...`);
    const submittedJob = await queue.addJob(
        'send-welcome-email',
        { userId: 'u_123', email: 'user@example.com' },
        { maxAttempts: 2 } 
    );
    
    console.log(`[Producer] JiNiQ auto-generated ID: ${submittedJob.id}`);

    // Let the demo run for a few seconds before shutting down
    setTimeout(async () => {
        await worker.stop();
        await queue.close(); // Clean up producer connections
        process.exit(0);
    }, 3000);
}

runRealWorldRetryDemo().catch(console.error);
```

---

## src/domain/Job.js

```javascript
const JobStatus = require('./JobStatus')

class Job {
  #id;
  #name;
  #payload;
  #priority;
  #runAt;
  #status;
  #attempt;
  #maxAttempts;
  #delay;
  #ttl;

  #createdAt;
  #updatedAt;
  #startedAt;
  #completedAt;
  #failedAt;
  #deadAt;

  #result;
  #failedReason;
  #stackTrace;
  #workerId;
  #finishedOn;

  constructor({
    id,
    name,
    payload = {},
    priority = "normal",
    delay = null,
    runAt = null,
    maxAttempts = 0,
    ttl = 30000
  } = {}) {

    if (!id) throw new Error("Job must have id");
    if (!name) throw new Error("Job must have name");

    const validPriorities = ["high", "normal"];
    let validatedPriority = priority;
    if (!validPriorities.includes(priority)) {
      console.warn(`[Jiniq Warning] Invalid priority "${priority}" passed for job "${name}". Defaulting to "normal".`);
      validatedPriority = "normal";
    }

    // assign to private fields
    this.#id = id;
    this.#name = name;
    this.#payload = payload;
    this.#priority = validatedPriority;
    this.#delay = delay;
    this.#ttl = ttl;
    this.#runAt = runAt;

    // state
    this.#status = JobStatus.WAITING;
    this.#attempt = 0;
    this.#maxAttempts = maxAttempts;

    // timestamps
    this.#createdAt = Date.now();
    this.#updatedAt = Date.now();
    this.#startedAt = null;
    this.#completedAt = null;
    this.#failedAt = null;
    this.#deadAt = null;

    // execution metadata
    this.#result = null;
    this.#failedReason = null;
    this.#stackTrace = null;
    this.#workerId = null;
    this.#finishedOn = null;
  }

  // this class i am defing to hash payload and other data different class wasnt created because if would be slow create overhead trigger garbage collection even mongodb follow this even if domain rule is broken
  toRedisHash() {
    return {
      id: this.#id,
      name: this.#name,
      payload: JSON.stringify(this.#payload), 
      priority: this.#priority,
      delay: this.#delay || 0,
      runAt: this.#runAt || 0,
      ttl: this.#ttl,
      
      status: this.#status,
      attempt: this.#attempt,
      maxAttempts: this.#maxAttempts,
      
      createdAt: this.#createdAt,
      updatedAt: this.#updatedAt,
      startedAt: this.#startedAt || '',
      completedAt: this.#completedAt || '',
      failedAt: this.#failedAt || '',
      deadAt: this.#deadAt || '',
      
      result: this.#result ? JSON.stringify(this.#result) : '',
      failedReason: this.#failedReason || '',
      stackTrace: this.#stackTrace || '',
      workerId: this.#workerId || '',
      finishedOn: this.#finishedOn || ''
    };
  }
  
  get id() { return this.#id; }
  get name() { return this.#name; }
  get payload() { return this.#payload; }
  get priority() { return this.#priority; }
  get delay() { return this.#delay; }
  get ttl() { return this.#ttl; }
  get runAt() { return this.#runAt; }

  get status() { return this.#status; }
  get attempt() { return this.#attempt; }
  get maxAttempts() { return this.#maxAttempts; }

  get createdAt() { return this.#createdAt; }
  get updatedAt() { return this.#updatedAt; }
  get startedAt() { return this.#startedAt; }
  get completedAt() { return this.#completedAt; }
  get failedAt() { return this.#failedAt; }
  get deadAt() { return this.#deadAt; }

  get result() { return this.#result; }
  get failedReason() { return this.#failedReason; }
  get stackTrace() { return this.#stackTrace; }
  get workerId() { return this.#workerId; }
  get finishedOn() { return this.#finishedOn; }

  // now the below method is static beacause we dont need to create instnace of a job to convert into hash its a already existing job we convert
  static fromRedisHash(rawHash) {
    const job = new Job({
      id: rawHash.id,
      name: rawHash.name,
      payload: rawHash.payload ? JSON.parse(rawHash.payload) : {},
      priority: rawHash.priority,
      delay: Number(rawHash.delay) || null,
      runAt: Number(rawHash.runAt) || null,
      maxAttempts: Number(rawHash.maxAttempts) || 0,
      ttl: Number(rawHash.ttl) || 30000
    });
    
    // atrribute that are not set in constructor
    job.#status = rawHash.status;
    job.#attempt = Number(rawHash.attempt) || 0;
    job.#createdAt = Number(rawHash.createdAt);
    job.#updatedAt = Number(rawHash.updatedAt);
    job.#startedAt = Number(rawHash.startedAt) || null;
    job.#completedAt = Number(rawHash.completedAt) || null;
    job.#failedAt = Number(rawHash.failedAt) || null;
    job.#deadAt = Number(rawHash.deadAt) || null;
    job.#result = rawHash.result ? JSON.parse(rawHash.result) : null;
    job.#failedReason = rawHash.failedReason || null;
    job.#stackTrace = rawHash.stackTrace || null;
    job.#workerId = rawHash.workerId || null;
    job.#finishedOn = rawHash.finishedOn || null;

    return job;
  }
}

module.exports = Job;
```

## src/domain/JobStatus.js

```javascript
const JobStatus = Object.freeze({
    WAITING:'waiting',
    ACTIVE: 'active',
    COMPLETED: 'completed',
    FAILED: 'failed',
    DEAD: 'dead',
    DELAYED: 'delayed',
})

module.exports = JobStatus;
```

## src/domain/events/BaseEvent.js

```javascript
const crypto = require('crypto');

class BaseEvent {
  #eventId;
  #createdAt;
  #eventType;

  constructor(eventType) {
    if (new.target === BaseEvent) {
      throw new Error("BaseEvent is abstract and cannot be instantiated directly");
    }

    if (!eventType) throw new Error("eventType is required");

    this.#eventId = crypto.randomUUID();
    this.#createdAt = Date.now();
    this.#eventType = eventType;
  }

  get eventId() { return this.#eventId; }
  get createdAt() { return this.#createdAt; }
  get eventType() { return this.#eventType; }

  baseJSON() {
    return {
      eventId: this.#eventId,
      eventType: this.#eventType,
      createdAt: this.#createdAt
    };
  }

  // simulate abstract method
  toJSON() {
    throw new Error("toJSON() must be implemented by subclass");
  }
}

module.exports = BaseEvent;
```

## src/domain/events/JobSubmitted.js

```javascript
const BaseEvent = require('./BaseEvent');

class JobSubmitted extends BaseEvent {
  #jobId;
  #name;
  #priority;

  constructor({ jobId, name, priority }) {
    super("JOB_SUBMITTED");

    if (!jobId) throw new Error("jobId required");
    if (!name) throw new Error("name required");

    this.#jobId = jobId;
    this.#name = name;
    this.#priority = priority || "normal";

    Object.freeze(this);
  }

  static fromJob(job) {
    return new JobSubmitted({
      jobId: job.id,
      name: job.name,
      priority: job.priority
    });
  }

  toJSON() {
    return {
      ...super.baseJSON(),
      jobId: this.#jobId,
      name: this.#name,
      priority: this.#priority
    };
  }
}

module.exports = JobSubmitted;
```

---

## src/infrastructure/db/BaseDB.js

```javascript
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
```

## src/infrastructure/db/BaseStorage.js

```javascript
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
```

## src/infrastructure/db/RedisDB.js

```javascript
const Redis = require('ioredis')
const BaseDB = require('./BaseDB')
const fs = require('fs')
const path = require('path')

const addJobLua = fs.readFileSync(path.join(__dirname, "../lua/AddJobLua.lua"), "utf8");
const waitToActiveLua = fs.readFileSync(path.join(__dirname, "../lua/ClaimNextJob.lua"), "utf8");
const checkAndUpdateHeartbeatLua = fs.readFileSync(path.join(__dirname, "../lua/CheckAndUpdateHeartbeat.lua"), "utf8");
const checkAndCompleteLua = fs.readFileSync(path.join(__dirname, "../lua/CheckAndComplete.lua"), "utf8");
const addToDelayedOrDeadLua = fs.readFileSync(path.join(__dirname, "../lua/AddToDelayedOrDeadLua.lua"), "utf8");
const sweeperLua = fs.readFileSync(path.join(__dirname, "../lua/Sweeper.lua"), "utf8");

class RedisDB extends BaseDB{
    constructor(config={}){
        super()

        this.client = new Redis({
            host: config.host || '127.0.0.1',
            port: config.port || 6379,
            retryStrategy: (times) => this.maxRetriesDbConnect(times),
            ...config
        })

        this.client.defineCommand('addJobtoQueue',{
            numberOfKeys: 4,
            lua:addJobLua
        });

        this.client.defineCommand('claimNextJob', {
            numberOfKeys: 6,
            lua: waitToActiveLua
        });

        this.client.defineCommand('renewJobLease', {
            numberOfKeys: 1,
            lua: checkAndUpdateHeartbeatLua
        });

        this.client.defineCommand('checkAndComplete',{
            numberOfKeys : 3,
            lua : checkAndCompleteLua
        })

        this.client.defineCommand('addToDelayedOrDead',{
            numberOfKeys : 4,
            lua : addToDelayedOrDeadLua
        })

        this.client.defineCommand('sweeper',{
            numberOfKeys : 3,
            lua : sweeperLua
        })
        this.client.on('error', (err) => console.error(`[RedisDB Port ${config.port || 6379}] Error:`, err));
    }
    maxRetriesDbConnect(times) {
        // Exponential backoff with a cap of 3 seconds
        return Math.min(times * 100, 3000);
    }

    async run(command,...args){
        if(typeof this.client[command]!=='function'){
            throw new Error(`Redis command or custom Lua script "${command}" does not exist.`);
        }
        return this.client[command](...args);
    }
  pipeline() {
        return this.client.pipeline();
    }
    
    async disconnect() {
        await this.client.quit();
    }

}

module.exports = RedisDB
```

## src/infrastructure/db/RedisFactory.js

```javascript
const RedisDB = require('./RedisDB');
const { isDeepStrictEqual } = require("node:util");

class RedisFactory {
    static #manager;
    static #fetcher;
    static #refCount = 0;
    static #config;

    static initialize(config = {}) {
        if (!this.#manager) {
            this.#config = JSON.parse(JSON.stringify(config)); 
            this.#manager = new RedisDB(config);
            this.#fetcher = new RedisDB(config);
            this.#refCount++;
            return;
        }

        if (!isDeepStrictEqual(config, this.#config)) {
            throw new Error("RedisFactory has already been initialized with another configuration.");
        }

        this.#refCount++;

    }

    static getManager() {
        if (!this.#manager)
            throw new Error("RedisFactory not initialized.");
        return this.#manager;
    }

    static getFetcher() {
        if (!this.#fetcher)
            throw new Error("RedisFactory not initialized.");
        return this.#fetcher;
    }

    static async release() {
        this.#refCount--;

        if (this.#refCount === 0) {
            await this.#manager.disconnect();
            await this.#fetcher.disconnect();

            this.#manager = null;
            this.#fetcher = null;
            this.#config = null;
            this.#refCount = 0;
        }
    }
}

module.exports = RedisFactory;
```

## src/infrastructure/db/RedisStorage.js

```javascript
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
            dead: `jiniq:${nameOfQ}:dead`
        }
        
        this.manager = ManagerInstance
        this.fetcher = FetcherInstance
    }

    async getPayload(jobId) {
        const payloadStr = await this.manager.client.hget(`${this.keyMap.main}:${jobId}`, 'payload');
        try {
            return payloadStr ? JSON.parse(payloadStr) : null;
        } catch (e) {
            return payloadStr; 
        }
    }

    async addJobToQueue(serializedJob, options = {}) {
        const jobId = serializedJob.id;
        const jobKey = `${this.keyMap.main}:${jobId}`;
        const priorityOffset = options.priorityOffset ?? 10000;
        
        // Exactly 4 keys to match RedisDB numberOfKeys: 4
        const keys = [
            jobKey,
            this.keyMap.priority,
            this.keyMap.normal,
            this.keyMap.delay
        ];
        
        const hashArgs = [];
        for (const [key, value] of Object.entries(serializedJob)) {
            let strValue;
            if (value == null) {
                strValue = ""; // Bug 23 Fix applied here
            } else if (typeof value === 'object') {
                strValue = JSON.stringify(value); 
            } else {
                strValue = value.toString();
            }
            hashArgs.push(key, strValue);
        }
        
        const timestamp = Date.now();
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
        const priorityOffset = options.priorityOffset ?? 10000; 
        const maxQueueSize = options.maxQueueSize || 0;

        for (let i = 0; i < serializedJobsArray.length; i += CHUNK_SIZE) {
            const chunk = serializedJobsArray.slice(i, i + CHUNK_SIZE);
            const pipeline = this.manager.pipeline();
            
            for (const serializedJob of chunk) {
                const jobId = serializedJob.id;
                const jobKey = `${this.keyMap.main}:${jobId}`;
                
                // Exactly 4 keys
                const keys = [
                    jobKey, 
                    this.keyMap.priority, 
                    this.keyMap.normal, 
                    this.keyMap.delay
                ];
                
                const hashArgs = [];
                for (const [key, value] of Object.entries(serializedJob)) {
                    let strValue;
                    if (value == null) {
                        strValue = ""; // Bug 23 Fix applied here
                    } else if (typeof value === 'object') {
                        strValue = JSON.stringify(value); 
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
                        case 1: 
                        case 0: 
                            successCount++;
                            break;
                        case -1: 
                            failedCount++;
                            failedJobs.push({ id: originalJobId, reason: 'QueueFullError: Reached max capacity' });
                            break;
                        default: 
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

        // Exactly 6 keys to match RedisDB numberOfKeys: 6
        const keys = [
            this.keyMap.priority,
            this.keyMap.normal, 
            this.keyMap.active,
            this.keyMap.lock,
            this.keyMap.delay,
            this.keyMap.main 
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

  async publishLog(jobId, status, payload, errorMsg = null) {
        const queueName = this.queueName || (this.keyMap && this.keyMap.main ? this.keyMap.main.split(':')[1] : 'unknown');
        const streamKey = `jiniq:${queueName}:logs`;

        // Safely handle the payload so it never outputs [object Object]
        let payloadStr = "";
        try {
            payloadStr = (payload && typeof payload === "object") 
                ? JSON.stringify(payload) 
                : String(payload);
        } catch (err) {
            payloadStr = '{"error": "Unparseable Payload"}';
        }

        // Force cast everything to strings to prevent Redis stream crashes
        await this.manager.client.xadd(
            streamKey,
            "MAXLEN", "~", 1000,   
            "*",
            "jobId", String(jobId),
            "status", String(status),
            "payload", payloadStr,
            "timestamp", Date.now().toString(),
            "error", errorMsg ? String(errorMsg) : ""
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

module.exports = RedisStorage;
```

---

## src/infrastructure/lua/AddJobLua.lua

```lua
-- KEYS[1]: jobKey (e.g., jiniq-draft:video-queue:main:job_123)
-- KEYS[2]: priority zset
-- KEYS[3]: normal list
-- KEYS[4]: delay zset
--KEYS[5] : notification channel 

-- ARGV[1]: jobId
-- ARGV[2]: priorityString ("high", "normal")
-- ARGV[3]: delay (milliseconds)
-- ARGV[4]: timestamp (current time)
-- ARGV[5]: priorityOffset (e.g., 10000ms)
--ARGV[6] : maxQueueSize
-- ARGV[7...]: hash fields and values

local jobKey = KEYS[1]
local priorityKey = KEYS[2]
local normalKey = KEYS[3]
local delayKey = KEYS[4]


local jobId = ARGV[1]
local priorityString = ARGV[2]
local delay = tonumber(ARGV[3])
local timestamp = tonumber(ARGV[4])
local priorityOffset = tonumber(ARGV[5])
local maxQueueSize = tonumber(ARGV[6]) or 0

if redis.call("EXISTS", jobKey) == 1 then 
    return 0 
end

if maxQueueSize > 0 then
   local currentNormalSize = redis.call("ZCARD", normalKey)
   local currentPrioritySize = redis.call("ZCARD", priorityKey)
    if (currentNormalSize + currentPrioritySize) >= maxQueueSize then
        return -1
    end
end

redis.call("HSET", jobKey, unpack(ARGV, 7))


-- ... (top part remains the same) ...

if delay > 0 then
    local runAt = timestamp + delay
    redis.call("ZADD", delayKey, runAt, jobId)
    redis.call("HSET", jobKey, "runAt", runAt)
    
elseif priorityString == "high" then
    local score = timestamp - priorityOffset
    redis.call("ZADD", priorityKey, score, jobId)
    
else
    -- [THE FIX]: Use ZADD instead of RPUSH for the normal queue!
    redis.call("ZADD", normalKey, timestamp, jobId)
end
 

return 1
```

## src/infrastructure/lua/AddToDelayedOrDeadLua.lua

```lua
local lockPrefix = KEYS[1]
local activeQ    = KEYS[2]
local delayQ     = KEYS[3]
local deadQ      = KEYS[4]

local jobId      = ARGV[1]
local workerId   = ARGV[2]
local jobKey     = ARGV[3]
local errorMsg   = ARGV[4]

local lockKey = lockPrefix .. ":" .. jobId

-- Verify lock ownership


local currentWorker = redis.call("GET", lockKey)

if currentWorker ~= workerId then
    return -1
end

-- Increment attempt counter


local currAttempt = redis.call("HINCRBY", jobKey, "attempt", 1)
local maxAttempt  = tonumber(redis.call("HGET", jobKey, "maxAttempts") or 0)

-- Remove lock and active entry


redis.call("DEL", lockKey)

local activePayload = jobId .. ":" .. workerId
redis.call("LREM", activeQ, 0, activePayload)

-- Retry


if currAttempt <= maxAttempt then

    redis.call("ZADD", delayQ, 0, jobId)

    redis.call(
    "HSET", jobKey,
    "status", "delayed",
    "failedReason", errorMsg,
    "workerId", workerId,
    "failedAt", tostring(redis.call("TIME")[1])
)

    return 1
end


-- Dead


redis.call("RPUSH", deadQ, jobId)

redis.call(
    "HSET", jobKey,
    "status", "dead",
    "failedReason", errorMsg,       
    "workerId", workerId,           
    "failedAt", tostring(redis.call("TIME")[1]),
    "deadAt", tostring(redis.call("TIME")[1])   -- NEW: tell Job.js when it died
)

return 2
```

## src/infrastructure/lua/CheckAndComplete.lua

```lua
local lockPrefix = KEYS[1]
local activeQ    = KEYS[2]
local completeQ  = KEYS[3]

local jobId        = ARGV[1]
local workerId     = ARGV[2]
local jobKey       = ARGV[3] 

local lockKey = lockPrefix .. ":" .. jobId
local currentWorker = redis.call('GET', lockKey)

if currentWorker == workerId then
    redis.call('DEL', lockKey)

    local activePayload = jobId .. ":" .. workerId
    redis.call('LREM', activeQ, 0, activePayload)

    redis.call('RPUSH', completeQ, jobId)
    
    -- Generate timestamp in milliseconds (TIME returns [seconds, microseconds])
    local time = redis.call('TIME')
    local timestampMs = tostring((time[1] * 1000) + math.floor(time[2] / 1000))
    
    -- Update the status AND the completedAt timestamp
    redis.call('HSET', jobKey, 'status', 'completed', 'completedAt', timestampMs)

    return 1 -- Success
end

return 0 -- Lock mismatch or job expired
```

## src/infrastructure/lua/CheckAndUpdateHeartbeat.lua

```lua
-- KEYS[1] = Lock
-- ARGV[1] = jobId
-- ARGV[2] = workerId
-- ARGV[3] = heartbeat (TTL in ms)
local jobKey = KEYS[1]..":"..ARGV[1]
local currentWorker = redis.call("GET", jobKey)

if not currentWorker then
    return 0 -- No lock exists
end

if currentWorker == ARGV[2] then
    redis.call("PEXPIRE", jobKey, ARGV[3])
    return 1 -- Success
else
    return -1 -- Zombie/Ownership mismatch
end
```

## src/infrastructure/lua/ClaimNextJob.lua

```lua
-- KEYS[1] = priority zset
-- KEYS[2] = normal zset
-- KEYS[3] = active list
-- KEYS[4] = lock prefix
-- KEYS[5] = delay zset  <-- [NEW] We need to pass the delay queue key!
-- KEYS[6] = job hash prefix

-- ARGV[1] = ttl (ms)
-- ARGV[2] = now (timestamp)
-- ARGV[3] = offset (priority offset)
-- ARGV[4] = workerId

local priorityQ = KEYS[1]
local normalQ   = KEYS[2]
local activeQ   = KEYS[3]
local lockPrefix = KEYS[4]
local delayQ    = KEYS[5]
local jobHashPrefix = KEYS[6]

local ttl       = tonumber(ARGV[1])
local now       = tonumber(ARGV[2])
local offset    = tonumber(ARGV[3]) or 10000   
local workerId  = ARGV[4]

-- ==========================================
-- STEP 1: MIGRATE READY DELAYED JOBS
-- ==========================================
-- Find any jobs in delayQ whose timestamp is in the past (<= now)
local readyDelayed = redis.call('ZRANGEBYSCORE', delayQ, '-inf', now)

if #readyDelayed > 0 then
    for _, dJobId in ipairs(readyDelayed) do
        -- Move them to the normal queue so they can be processed
        redis.call('ZADD', normalQ, now, dJobId)
        redis.call('ZREM', delayQ, dJobId)
    end
end

-- ==========================================
-- STEP 2: FETCH THE HIGHEST PRIORITY JOB
-- ==========================================
local prioData = redis.call('ZRANGE', priorityQ, 0, 0, 'WITHSCORES')
local normData = redis.call('ZRANGE', normalQ, 0, 0, 'WITHSCORES')

local jobId = nil
local source = nil

if #prioData > 0 and #normData > 0 then
    local prioId    = prioData[1]
    local prioScore = tonumber(prioData[2])

    local normId    = normData[1]
    local normScore = tonumber(normData[2])

  if prioScore <= normScore then
    jobId = prioId
    source = priorityQ
else
    jobId = normId
    source = normalQ
end

elseif #prioData > 0 then
    jobId = prioData[1]
    source = priorityQ
elseif #normData > 0 then
    jobId = normData[1]
    source = normalQ
end

-- ==========================================
-- STEP 3: CLAIM THE JOB AND SET LOCKS
-- ==========================================
if jobId then
    local jobScore = tonumber(redis.call('ZSCORE', source, jobId))
    
    -- Safety check: ensure the job isn't scheduled for the future
    if jobScore > now then
        return nil
    end

    local jobKey = lockPrefix .. ":" .. jobId 

    if redis.call('EXISTS', jobKey) == 1 then
        redis.call('ZREM', source, jobId)
        return 0
    end

    -- Move to active queue
    redis.call('RPUSH', activeQ, jobId .. ":" .. workerId) 

    -- Set lock with TTL
    redis.call('PSETEX', jobKey, ttl, workerId)  

    -- Remove from source queue
    redis.call('ZREM', source, jobId)

    --Set job status to active metadata is updated
    redis.call('HSET', jobHashPrefix .. ":" .. jobId,
        'status', 'active',
        'workerId', workerId,
        'startedAt', now)
    return jobId
end

return nil
```

## src/infrastructure/lua/Sweeper.lua

```lua
local activeQ = KEYS[1]
local delayQ = KEYS[2]
local deadQ = KEYS[3]

local lockPrefix = ARGV[1]
local jobHashPrefix = ARGV[2]

-- Get all jobs currently in the active queue
local activeJobs = redis.call('LRANGE', activeQ, 0, -1)
local sweptCount = 0

for _, payload in ipairs(activeJobs) do
    -- Extract jobId from the "jobId:workerId" payload
    local splitIndex = string.find(payload, ":")
    
    if splitIndex then
        local jobId = string.sub(payload, 1, splitIndex - 1)
        
        local lockKey = lockPrefix .. ":" .. jobId
        local jobHashKey = jobHashPrefix .. ":" .. jobId
        
        -- If the lock is missing, the heartbeat flatlined (Worker crashed or stalled)
        if redis.call('EXISTS', lockKey) == 0 then
            
            -- 1. Remove from active queue
            redis.call('LREM', activeQ, 0, payload)
            
            -- 2. Atomically increment the attempt counter
            local currAttempt = redis.call('HINCRBY', jobHashKey, 'attempt', 1)
            
            -- Safely parse maxAttempts
            local maxAttemptRaw = redis.call('HGET', jobHashKey, 'maxAttempts')
            local maxAttempt = 0
            if maxAttemptRaw then
                maxAttempt = tonumber(maxAttemptRaw) or 0
            end
            
            -- 3. Route and UPDATE STATUS based on attempts
            if currAttempt <= maxAttempt then
                -- Move to delayed queue
                redis.call('ZADD', delayQ, 0, jobId)
                redis.call('HSET', jobHashKey, 'status', 'delayed')
            else
                -- Max attempts reached, push to dead letter list
                redis.call('RPUSH', deadQ, jobId)
                redis.call('HSET', jobHashKey, 'status', 'dead')
            end
            
            sweptCount = sweptCount + 1
        end
    end
end

return sweptCount
```

---

## src/queue/Jiniq.js

```javascript
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
```

---

## src/utils/IdGenerator.js

```javascript
const { randomUUID } = require('node:crypto');

class IdGenerator {
    // A static method means we don't have to use 'new IdGenerator()' every time
    static generate() {
        return randomUUID();
    }
}

module.exports = IdGenerator;
```

---

## src/worker/Heartbeat.js

```javascript
class HeartBeat {
    #stopHeartbeat = false;
    #resolveSleep = null;
    #timeoutId = null;

    constructor(ttl, workerId, jobId, dbActions, abortFn) {
        this.ttl = ttl;
        this.workerId = workerId;
        this.jobId = jobId;
        this.dbActions = dbActions;
        this.abortFn = abortFn;
    }

    sleep = (ms) => {
        return new Promise((resolve) => {
            this.#resolveSleep = resolve;

            this.#timeoutId = setTimeout(() => {
                this.#resolveSleep = null;
                this.#timeoutId = null;
                resolve();
            }, ms);
        });
    }

    getStopHeartBeat() {
        return this.#stopHeartbeat;
    }

    setStopHeartBeat(value) {

        this.#stopHeartbeat = value;

        if (value) {

            if (this.#timeoutId) {
                clearTimeout(this.#timeoutId);
                this.#timeoutId = null;
            }

            if (this.#resolveSleep) {
                this.#resolveSleep();
                this.#resolveSleep = null;
            }
        }
    }

    randomOffset = async () => {

        const jitter = Math.random() * 50;
        await this.sleep(jitter);

    }

    runHeartbeat = async () => {

        try {

            while (!this.#stopHeartbeat) {

                await this.sleep(this.ttl / 3);

                if (this.#stopHeartbeat) break;

                const heartBeatResp =
                    await this.dbActions.checkAndUpdateHeartbeat();

                if (heartBeatResp !== 1) {

                    console.warn(
                        `\n[Heartbeat ${this.jobId}] Lease lost. Aborting worker.\n`
                    );

                    this.setStopHeartBeat(true);

                    if (this.abortFn) {
                        this.abortFn();
                    }

                    break;
                }
            }

        } catch (e) {

            console.error(
                `\n[Heartbeat ${this.jobId}] Heartbeat crashed`
            );
            console.error(e);
            console.error();

            this.setStopHeartBeat(true);

            if (this.abortFn) {
                this.abortFn();
            }
        }
    }

    startHeartbeatProcess = async () => {

        await this.randomOffset();

        const resp =
            await this.dbActions.checkAndUpdateHeartbeat();

        if (resp !== 1) {

            console.warn(
                `\n[Heartbeat ${this.jobId}] Initial lease validation failed\n`
            );

            this.setStopHeartBeat(true);

            if (this.abortFn) {
                this.abortFn();
            }

            return;
        }

        this.runHeartbeat();
    }
}

module.exports = HeartBeat;
```

## src/worker/JobExecutor.js

```javascript
class JobExecutor {
    constructor(Heartbeat, jobId, workerId, ttl, maxTimeoutMs, userProcess, dbActions) {
        this.ttl = ttl;
        this.maxTimeoutMs = maxTimeoutMs;
        this.workerId = workerId;
        this.jobId = jobId;
        this.userProcess = userProcess;
        this.Heartbeat = Heartbeat;
        this.dbActions = dbActions;
    }

    beginWork = async () => {
        console.log(`\n[Job ${this.jobId}] Started (Worker ${this.workerId})\n`);

        const controller = new AbortController();

        const newHeartbeatInstance = new this.Heartbeat(
            this.ttl,
            this.workerId,
            this.jobId,
            this.dbActions,
            () => controller.abort()
        );

        let timeoutId;
        let payload = null;

        try {
            payload = await this.dbActions.getPayload(this.jobId);
            if (payload && typeof payload === 'object') {
                payload.id = this.jobId;
            }

            // 1. ADDED: Log the 'Started' event properly
            await this.dbActions.publishLog('Started', payload);

            await newHeartbeatInstance.startHeartbeatProcess();

            const timeoutPromise = new Promise((_, reject) => {
                timeoutId = setTimeout(() => {
                    controller.abort();
                    reject(
                        new Error(
                            `JOB_TIMEOUT: Process exceeded ${this.maxTimeoutMs}ms`
                        )
                    );
                }, this.maxTimeoutMs);
            });

            const resp = await Promise.race([
                this.userProcess(payload, controller.signal),
                timeoutPromise
            ]);

            clearTimeout(timeoutId);
            const completed = await this.dbActions.addToCompleted();
            if (completed === 0) {
                console.log("Zombie worker detected.");
                throw new Error("LEASE_LOST");
            }

            try {
                if (completed === 1) {
                    // 2. FIXED: Added this.jobId as the first argument
                    await this.dbActions.publishLog(
                        'Completed',
                        payload
                    );
                }
            } catch (dbErr) {
                console.error(`[Job ${this.jobId}] Failed to persist completion`);
                console.error(dbErr);
            }

            console.log(`\n[Job ${this.jobId}] ✓ Completed\n`);
            return resp;

        } catch (e) {
            clearTimeout(timeoutId);
            controller.abort();
            
            if (e.message === "LEASE_LOST") {
                console.warn(`[Job ${this.jobId}] Lease lost. Discarding stale result.`);
                throw e;
            }

            try {
                await this.dbActions.addToFailed(e);

                // 3. FIXED: Added this.jobId as the first argument
                await this.dbActions.publishLog(
                    'Failed',
                    payload,
                    e.stack || e.message
                );

            } catch (dbErr) {
                console.error(`[Job ${this.jobId}] Failed to persist failure`);
                console.error(dbErr);
            }

            console.error(`\n[Job ${this.jobId}] ✗ Failed`);
            console.error(e.message);
            console.error();
            throw e;

        } finally {
            newHeartbeatInstance.setStopHeartBeat(true);
        }
    }
}

module.exports = JobExecutor;
```

## src/worker/Supervisor.js

```javascript
const IdGenerator = require('../utils/IdGenerator');
const EventEmitter = require('events');

class Supervisor extends EventEmitter {
    #activeClaim = false;
    #pollInterval = 50;
    #forceShutdown = false;
    #sweeperInterval = 7000;
    #timeoutId = null;

    constructor(jobJson) {
        super();

        this.name = jobJson.name;
        this.JobExecutor = jobJson.JobExecutor;
        this.Heartbeat = jobJson.Heartbeat;
        this.userProcess = jobJson.userProcess;
        this.maxConcurrency = jobJson.maxConcurrency;

        this.storage = jobJson.storage;

        this.activeWorkers = new Set();
        this.maxTimeoutMs = jobJson.maxTimeoutMs;
        this.ttl = jobJson.ttl;
        this.priorityOffset = jobJson.priorityOffset;

        if (jobJson.sweeperInterval) {
            this.#sweeperInterval = jobJson.sweeperInterval;
        }

        this.sweeper = jobJson.sweeper;

        console.log(`\n[Supervisor ${this.name}] Initialized`);
        console.log(`  Concurrency : ${this.maxConcurrency}`);
        console.log(`  TTL         : ${this.ttl} ms`);
        console.log(`  Timeout     : ${this.maxTimeoutMs} ms\n`);
    }

    start = async () => {
        console.log(`\n[Supervisor ${this.name}] Starting...\n`);

        this.sweeper.start();
        this.callClaimHandler();

        await this.claimHandler();
    }

    hasSlot = () => {
        return this.activeWorkers.size < this.maxConcurrency;
    }

    fetchJob = async () => {
        const workerId = IdGenerator.generate();

        const jobId = await this.storage.fromWaitingToActive({
            ttl: this.ttl,
            priorityOffset: this.priorityOffset,
            workerId,
        });

        if (!jobId) return null;

        console.log(
            `\n[Supervisor ${this.name}] Claimed Job ${jobId} -> Worker ${workerId}\n`
        );

        return { jobId, workerId };
    }

    claimHandler = async () => {

        if (this.#forceShutdown || this.#activeClaim) return;

        this.#activeClaim = true;
        let foundWork = false;

        try {

            while (!this.#forceShutdown && this.hasSlot()) {

                const returnedObject = await this.fetchJob();

                if (!returnedObject) break;

                foundWork = true;

                this.assignJob(returnedObject).catch(err => {

                    console.error(
                        `[Supervisor ${this.name}] Failed to assign Job ${returnedObject.jobId}`
                    );
                    console.error(err);

                    this.activeWorkers.delete(returnedObject.workerId);
                });
            }

        } catch (e) {

            console.error(`[Supervisor ${this.name}] Claim loop crashed`);
            console.error(e);

        } finally {

            this.#activeClaim = false;

            if (foundWork) {

                this.#pollInterval = 50;
                this.emit('claimNextJob');

            } else {

                this.#pollInterval = Math.min(this.#pollInterval * 1.5, 2000);

                this.#timeoutId = setTimeout(() => {
                    this.emit('claimNextJob');
                }, this.#pollInterval);
            }
        }
    }

    assignJob = async (jobJson) => {

        const { jobId, workerId } = jobJson;

        const dbActions = {
            getPayload: () => this.storage.getPayload(jobId),
            addToCompleted: () => this.storage.addToCompleted(workerId, jobId),
            addToFailed: (err) => this.storage.addToFailed(jobId, workerId, err),
            checkAndUpdateHeartbeat: () =>
                this.storage.checkAndUpdateHeartbeat(this.ttl, jobId, workerId),
            publishLog: (status, payload, error) =>
                this.storage.publishLog(jobId, status, payload, error)
        };

        const newWorker = new this.JobExecutor(
            this.Heartbeat,
            jobId,
            workerId,
            this.ttl,
            this.maxTimeoutMs,
            this.userProcess,
            dbActions
        );

        const workerPromise = Promise.resolve().then(() => {
            return newWorker.beginWork();
        });

        this.activeWorkers.add(workerId);

        workerPromise
            .then((resp) => {

                console.log(
                    `\n[Worker ${workerId}] ✓ Job ${jobId} completed\n`
                );

                this.emit('job:completed', {
                    jobId,
                    workerId,
                    result: resp
                });

            })
            .catch(err => {

                console.error(
                    `\n[Worker ${workerId}] ✗ Job ${jobId} failed`
                );
                console.error(err.message);
                console.error();

                this.emit('job:failed', {
                    jobId,
                    workerId,
                    error: err.message
                });

            })
            .finally(() => {

                this.activeWorkers.delete(workerId);

                this.#pollInterval = 50;

                if (!this.#activeClaim && !this.#forceShutdown) {
                    clearTimeout(this.#timeoutId);
                    this.claimHandler();
                }
            });

        return;
    }

    get availableSlots() {
        return this.maxConcurrency - this.activeWorkers.size;
    }

    callClaimHandler = () => {

        this.on('claimNextJob', async () => {

            try {
                await this.claimHandler();
            } catch (e) {
                console.error(`[Supervisor ${this.name}] claimNextJob crashed`);
                console.error(e);
            }

        });

    }

    stop = async () => {

        console.log(`\n[Supervisor ${this.name}] Shutting down...\n`);

        this.#forceShutdown = true;

        clearTimeout(this.#timeoutId);

        if (this.sweeper && typeof this.sweeper.stop === 'function') {
            this.sweeper.stop();
        }

        console.log(`[Supervisor ${this.name}] Shutdown complete\n`);
    }
}

module.exports = Supervisor;
```

## src/worker/Sweeper.js

```javascript
class Sweeper {
    #intervalId = null;
    #isRunning = false;
    #pollIntervalMs;
    #storage;

    constructor(storage, pollIntervalMs = 30000) {
        this.#storage = storage;
        this.#pollIntervalMs = pollIntervalMs;
    }

    start = () => {

        if (this.#isRunning) return;

        this.#isRunning = true;
        
        console.log(`[Sweeper] Started running every ${this.#pollIntervalMs}ms`);

        this.#intervalId = setInterval(async () => {
            try {
                const sweptCount = await this.#storage.sweepZombies();
                if (sweptCount > 0) {
                    console.log(`[Sweeper] Recovered ${sweptCount} zombie job(s).`);
                }
            } catch (error) {
                console.error("[Sweeper] Error during sweeping cycle:", error);
            }
        }, this.#pollIntervalMs);
        this.#intervalId.unref();
    }

    stop = () => {

        if (!this.#intervalId) return;

        clearInterval(this.#intervalId);

        this.#intervalId = null;
        this.#isRunning = false;

        console.log(`\n[Sweeper] Stopped\n`);
    }
}
module.exports = Sweeper;
```

## src/worker/Worker.js

```javascript
const { EventEmitter } = require('events');
const RedisFactory = require('../infrastructure/db/RedisFactory');
const RedisStorage = require('../infrastructure/db/RedisStorage');
const Supervisor = require('./Supervisor');
const Sweeper = require('./Sweeper');
const JobExecutor = require('./JobExecutor');
const HeartBeat = require('./Heartbeat');

class Worker extends EventEmitter {
    #storageInstance;

    constructor(queueName, processorFn, options = {}) {
        super();
        
        if (!queueName || typeof processorFn !== 'function') {
            throw new Error('Jiniq Worker: Queue name and a processor function are strictly required.');
        }

        this.queueName = queueName;
        
        const redisConfig = options.redisConfig || {};
        RedisFactory.initialize(redisConfig);
        const manager = RedisFactory.getManager();
        const fetcher = RedisFactory.getFetcher();
        
        this.#storageInstance = new RedisStorage(queueName, manager, fetcher, redisConfig);

     
        this.sweeper = new Sweeper(this.#storageInstance, options.sweeperInterval || 7000);
        

        this.supervisor = new Supervisor({
            name: queueName,
            JobExecutor: JobExecutor,
            Heartbeat: HeartBeat,
            userProcess: processorFn,
            maxConcurrency: options.concurrency || 1,
            storage: this.#storageInstance,
            sweeper: this.sweeper,
            ttl: options.lockDuration || 30000,
            priorityOffset: options.priorityOffset || 10000,
            sweeperInterval: options.sweeperInterval || 7000,
            maxTimeoutMs: options.maxTimeoutMs || 300000 
        });
        this.supervisor.on('job:completed', (data) => {
            this.emit('job:completed', data);
        });

        this.supervisor.on('job:failed', (data) => {
            this.emit('job:failed', data);
        });
    }

    async start() {
        console.log(`[Jiniq Worker] Booting up consumer for queue "${this.queueName}"...`);
        await this.supervisor.start();
    }

    async stop() {
        console.log(`[Jiniq Worker] Initiating graceful shutdown...`);
        await this.supervisor.stop();
        await RedisFactory.release();
        console.log(`[Jiniq Worker] Offline.`);
    }
} 

module.exports = Worker;
```

---

## test/happy-path/producer_hp.js

```javascript
const { Jiniq }= require("jiniq-js");

(async () => {

    const queue = new Jiniq("happy-path-trial-queue");

    console.log("\n📦 Producer adding image-processing job...\n");

    const job = await queue.addJob(
        "resize-image",
        {
            image: "profile.png"
        },
        { maxAttempts: 2 } 
    );

    console.log(`✅ Job Submitted : ${job.id}`);

})();
```

## test/happy-path/worker_hp.js

```javascript
const { Worker } = require("jiniq-js");

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

(async () => {

    const worker = new Worker(
        "happy-path-trial-queue",

        async (job) => {

            console.log("\n================================");
            console.log("Started Processing");
            console.log("================================");

            console.log("resizing image...");
            await sleep(12000);


            console.log("✅ Processing Finished");

        },

        {
            concurrency: 1,

            // Heartbeat expires quickly
            lockDuration: 7000,

            // Sweeper checks frequently
            sweeperInterval: 3000
        }
    );

    worker.on("job:completed", ({ jobId }) => {
        console.log(`🎉 Job Completed : ${jobId}`);
    });

    worker.on("job:failed", ({ jobId }) => {
        console.log(`❌ Job Failed : ${jobId}`);
    });

    process.on("SIGINT", async () => {
        console.log("\n💥 Simulating Machine Crash...");
        process.exit(1);
    });

    await worker.start();

})();
```

## test/heartbeat-failure-normal/producer.js

```javascript
const Jiniq = require("../../src/queue/Jiniq");

(async () => {

    const queue = new Jiniq("hearbeat-failure-processing");

    console.log("\n📦 Producer adding image-processing job...\n");

    const job = await queue.addJob(
        "resize-image",
        {
            image: "profile.png"
        },
        { maxAttempts: 2 } 
    );

    console.log(`✅ Job Submitted : ${job.id}`);

})();
```

## test/heartbeat-failure-normal/workerA.js

```javascript
const Worker = require("../../src/worker/Worker");

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {

    const worker = new Worker(
        "hearbeat-failure-processing",

        async (job) => {

            console.log("\n==============================");
            console.log("Worker A");
            console.log("==============================");

            console.log(`Claimed Job : ${job.id}`);

            console.log("Downloading Image...");
            await sleep(2000);

            console.log("Applying AI Filters...");
            await sleep(3000);

            console.log("\n💥 MACHINE CRASHED");
            console.log("Heartbeat stops...");
            console.log("Lease will expire...");
            console.log();

            process.exit(1);

        },

        {
            concurrency: 1
        }

    );

    await worker.start();

})();
```

## test/heartbeat-failure-normal/workerB.js

```javascript
const Worker = require("../../src/worker/Worker");

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {

    console.log("Starting Worker B...");

    const worker = new Worker(

        "hearbeat-failure-processing",

        async (job) => {

            console.log("\n==============================");
            console.log("Worker B");
            console.log("==============================");

            console.log(`Recovered Job : ${job.id}`);

            console.log("Processing Image...");
            await sleep(3000);

            console.log("Uploading Output...");
            await sleep(1000);

            console.log(`✅ Job ${job.id} Completed`);

        },

        {
            concurrency: 1
        }

    );

    worker.on("job:completed", ({ jobId }) => {

        console.log(`\n🎉 Recovery Successful : ${jobId}`);

    });

    await worker.start();

})();
```

## test/process-crash/producer_pc.js

```javascript
const Jiniq = require("../../src/queue/Jiniq");

(async () => {

    const queue = new Jiniq("process-crash-trial-queue");

    console.log("\n📦 Producer adding welcome-email job...\n");

    const job = await queue.addJob(
        "send-welcome-email",
        {
            userId: "u_123",
            email: "user@example.com"
        },
        {
            maxAttempts: 2
        }
    );

    console.log(`✅ Job Submitted : ${job.id}`);

})();
```

## test/process-crash/worker_pc.js

```javascript
const Worker = require("../../src/worker/Worker");

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Simulates a flaky external API.
// First attempt fails.
// Second attempt succeeds.
const failureTracker = new Map();

(async () => {

    const worker = new Worker(

        "process-crash-trial-queue",

        async (job) => {

            console.log("\n================================");
            console.log(`📨 Processing Job : ${job.id}`);
            console.log("================================");

            const attempts = failureTracker.get(job.id) || 0;

            if (attempts === 0) {

                failureTracker.set(job.id, 1);

                console.log("Connecting to Email Service...");
                await sleep(5000);

                console.log("Connection Lost!");
                throw new Error("Connection reset by peer (SendGrid API)");
            }

            console.log("Retry Attempt...");
            await sleep(7000);

            console.log("Sending Welcome Email...");
            await sleep(2500);

            console.log("✅ Email Sent Successfully!");

        },

        {
            concurrency: 1,

            lockDuration: 7000,

            sweeperInterval: 3000
        }

    );


    await worker.start();

})();
```

## test/worker-blip/producer_wb.js

```javascript
const Jiniq = require("../../src/queue/Jiniq");

(async () => {

    const queue = new Jiniq("worker-blip-trial-queue");

    console.log("\n📦 Producer adding image-processing job...\n");

    const job = await queue.addJob(
        "resize-image",
        {
            image: "profile.png"
        },
        { maxAttempts: 2 } 
    );

    console.log(`✅ Job Submitted : ${job.id}`);

})();
```

## test/worker-blip/worker_wb.js

```javascript
const Worker = require("../../src/worker/Worker");

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

(async () => {

    const worker = new Worker(
        "worker-blip-trial-queue",

        async (job) => {

            console.log("\n================================");
            console.log("Started Processing");
            console.log("================================");

            console.log("Downloading image...");
            await sleep(10000);

            console.log("Applying AI filters...");
            await sleep(3000);

            console.log("Generating thumbnail...");
            await sleep(3000);

            console.log("Uploading output...");
            await sleep(3000);

            console.log("✅ Processing Finished");

        },

        {
            concurrency: 1,

            // Heartbeat expires quickly
            lockDuration: 3000,

            // Sweeper checks frequently
            sweeperInterval: 10000
        }
    );

    worker.on("job:completed", ({ jobId }) => {
        console.log(`🎉 Job Completed : ${jobId}`);
    });

    worker.on("job:failed", ({ jobId }) => {
        console.log(`❌ Job Failed : ${jobId}`);
    });

    process.on("SIGINT", async () => {
        console.log("\n💥 Simulating Machine Crash...");
        process.exit(1);
    });

    await worker.start();

})();
```

## test/zombie-worker/producer_zw.js

```javascript
const Jiniq = require("../../src/queue/Jiniq");

(async () => {

    const queue = new Jiniq("zombie-worker-trial-queue");

    console.log("\n📦 Producer adding image-processing job...\n");

    const job = await queue.addJob(
        "resize-image",
        {
            image: "profile.png"
        },
        { maxAttempts: 2 } 
    );

    console.log(`✅ Job Submitted : ${job.id}`);

})();
```

## test/zombie-worker/workerA_zw.js

```javascript
const Worker = require("../../src/worker/Worker");

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Synchronously blocks the Node.js event loop
function sleepSync(ms) {
    const end = Date.now() + ms;

    while (Date.now() < end) {
        // Busy waiting
    }
}

(async () => {

    const worker = new Worker(
        "zombie-worker-trial-queue",

        async (job) => {

            console.log("\n================================");
            console.log("Started Processing");
            console.log("================================");

            console.log("Downloading image...");
            await sleep(3000);

            console.log("\n CPU enters an infinite computation...");
            console.log(" Event Loop Frozen for 10 seconds...");
            sleepSync(10000); // Heartbeat cannot run here

            console.log("\n✅ CPU computation finished.");

            console.log("Applying AI filters...");
            await sleep(3000);

            console.log("Generating thumbnail...");
            await sleep(3000);

            console.log("Uploading output...");
            await sleep(3000);

            console.log("✅ Processing Finished");

        },

        {
            concurrency: 1,

            // Heartbeat expires during the freeze
            lockDuration: 3000,

            // Sweeper checks frequently
            sweeperInterval: 15000
        }
    );

    worker.on("job:completed", ({ jobId }) => {
        console.log(`🎉 Job Completed : ${jobId}`);
    });

    worker.on("job:failed", ({ jobId }) => {
        console.log(`❌ Job Failed : ${jobId}`);
    });

    process.on("SIGINT", async () => {
        console.log("\n💥 Simulating Machine Crash...");
        process.exit(1);
    });

    await worker.start();

})();
```

## test/zombie-worker/workerB_zw.js

```javascript
const Worker = require("../../src/worker/Worker");

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {

    console.log("Starting Worker B...");

    const worker = new Worker(

        "zombie-worker-trial-queue",

        async (job) => {

            console.log("\n==============================");
            console.log("Worker B");
            console.log("==============================");

            console.log(`Recovered Job : ${job.id}`);

            console.log("Processing Image...");
            await sleep(3000);

            console.log("Uploading Output...");
            await sleep(1000);

            console.log(`✅ Job ${job.id} Completed`);

        },

        {
            concurrency: 1
        }

    );

    worker.on("job:completed", ({ jobId }) => {

        console.log(`\n🎉 Recovery Successful : ${jobId}`);

    });

    await worker.start();

})();
```

---

## package.json

```json
{
  "name": "jiniq-js",
  "version": "1.0.0",
  "description": "A Redis-backed distributed job queue for Node.js, built for correctness under failure.",
  "main": "src/index.js",
  "scripts": {
    "test": "echo \"Error: no test specified\" && exit 1"
  },
  "keywords": [
    "job",
    "queue",
    "redis",
    "background",
    "worker",
    "task",
    "lua"
  ],
  "contributors": [
    "Jishnu Nair",
    "Nilay Shahane"
  ],
  "license": "MIT",
  "dependencies": {
    "ioredis": "^6.0.0",
    "jiniq-js": "^1.0.0"
  }
}
```