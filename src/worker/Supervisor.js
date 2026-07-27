const IdGenerator = require('../utils/IdGenerator');
const EventEmitter = require('events');

class Supervisor extends EventEmitter {
    #activeClaim = false;
    #pollInterval = 50; 
    #forceShutdown = false;
    #sweeperInterval = 30000;
    #timeoutId = null; // Tracked properly!

    constructor(jobJson) {
        super();
        this.name = jobJson.name;
        this.JobExecutor = jobJson.JobExecutor;
        this.Heartbeat = jobJson.Heartbeat; 
        this.userProcess = jobJson.userProcess;
        this.maxConcurrency = jobJson.maxConcurrency;
        
        // Storage and Architecture injected from Worker.js
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
    }

    start = async () => {
        this.sweeper.start(this.#sweeperInterval);
        this.callClaimHandler();
        await this.claimHandler();
    }

    hasSlot = () => {
        return (this.activeWorkers.size < this.maxConcurrency);
    }

    // Safely returns the { jobId, workerId } object
    fetchJob = async () => {
        
        const workerId = IdGenerator.generate();
        const jobId = await this.storage.fromWaitingToActive({
            ttl: this.ttl,
            priorityOffset: this.priorityOffset,
            workerId: workerId,
        });
        
        if (!jobId) return null;
        return { jobId, workerId };
    }
    
    claimHandler = async () => {
        if(this.#forceShutdown || this.#activeClaim) return;
        this.#activeClaim = true;
        let foundWork = false; 

        try {
            while(!(this.#forceShutdown) && this.hasSlot()) {
                const returnedObject = await this.fetchJob();
                if(!returnedObject) break;
                
                foundWork = true;
                this.assignJob(returnedObject).catch(err => {
                    console.error(`Slot assignment failed for job ${returnedObject.jobId}`, err);
                    this.activeWorkers.delete(returnedObject.workerId);
                });
            }
        }
        catch(e) {
            console.error("Error during job claiming process:", e);
        }
        finally {
            this.#activeClaim = false;
            
            if (foundWork) {
                this.#pollInterval = 50; 
                this.emit('claimNextJob'); 
            } else {
                this.#pollInterval = Math.min(this.#pollInterval * 1.5, 2000);
                // FIXED: Tracking the timeoutId so we can clear it later!
                this.#timeoutId = setTimeout(() => this.emit('claimNextJob'), this.#pollInterval);
            }
        }
    }

    assignJob = async (jobJson) => {
        const { jobId, workerId } = jobJson;

        // Bundle the methods back into the dbActions object that JobExecutor expects
        const dbActions = {
            getPayload: () => this.storage.getPayload(jobId),
            addToCompleted: () => this.storage.addToCompleted(workerId, jobId),
            addToFailed: (err) => this.storage.addToFailed(jobId, workerId, err),
            checkAndUpdateHeartbeat: () => this.storage.checkAndUpdateHeartbeat(this.ttl, jobId, workerId),
            publishLog: (status, payload, error) => this.storage.publishLog(jobId, status, payload, error)
        };

        const newWorker = new this.JobExecutor(
            this.Heartbeat, 
            jobId, 
            workerId, 
            this.ttl, 
            this.maxTimeoutMs, 
            this.userProcess, 
            dbActions // Pass the object here!
        );

        const workerPromise = Promise.resolve().then(() => newWorker.beginWork());

        this.activeWorkers.add(workerId);

        workerPromise.then((resp) => {
            this.emit('job:completed', { jobId, workerId, result: resp });
        })
        .catch(err => {
            console.error(`[Job ${jobId} Failed]:`, err.message);
            this.emit('job:failed', { jobId, workerId, error: err.message });
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
            }
            catch(e) {
                console.error(e); 
            }
        });
    }   

    stop = async () => {
        console.log(`[Supervisor ${this.name}] Shutting down...`);
        this.#forceShutdown = true; 
        clearTimeout(this.#timeoutId); // Free up the event loop on exit
        if (this.sweeper && typeof this.sweeper.stop === 'function') {
            this.sweeper.stop();
        }
        console.log("Shutdown complete.");
    }
}

module.exports = Supervisor;