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
        this.stateManager = jobJson.stateManager;

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