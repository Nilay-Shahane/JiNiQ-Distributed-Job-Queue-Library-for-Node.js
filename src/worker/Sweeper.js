// Sweeper.js
class Sweeper {
    #intervalId = null;
    #isRunning = false;

    constructor(storage, pollIntervalMs = 30000) {
        this.storage = storage;  
        this.#pollIntervalMs = pollIntervalMs;
    }

    start = () => {
        if (this.#isRunning) return;
        this.#isRunning = true;
        
        console.log(`[Sweeper] Started running every ${pollIntervalMs}ms`);

        this.#intervalId = setInterval(async () => {
            try {
                const sweptCount = await this.storage.sweepZombies();
                if (sweptCount > 0) {
                    console.log(`[Sweeper] Recovered ${sweptCount} zombie job(s).`);
                }
            } catch (error) {
                console.error("[Sweeper] Error during sweeping cycle:", error);
            }
        }, pollIntervalMs);

        
        this.#intervalId.unref(); 
    }

    stop = () => {
        if (this.#intervalId) {
            clearInterval(this.#intervalId);
            this.#intervalId = null;
            this.#isRunning = false;
            console.log("[Sweeper] Stopped.");
        }
    }
}

module.exports = Sweeper;