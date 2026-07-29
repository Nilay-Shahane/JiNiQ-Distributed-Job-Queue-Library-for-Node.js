class Sweeper {
    #intervalId = null;
    #isRunning = false;

    constructor(storage, pollIntervalMs = 5000) {
        this.storage = storage;
        this.pollIntervalMs = pollIntervalMs;
    }

    start = () => {

        if (this.#isRunning) return;

        this.#isRunning = true;

        console.log(`\n[Sweeper] Started (${this.pollIntervalMs}ms interval)\n`);

        this.#intervalId = setInterval(async () => {

            try {

                const sweptCount = await this.storage.sweepZombies();

                if (sweptCount > 0) {
                    console.log(
                        `\n[Sweeper] Recovered ${sweptCount} zombie job(s)\n`
                    );
                }

            } catch (error) {

                console.error(`\n[Sweeper] Sweep failed`);
                console.error(error);
                console.error();

            }

        }, this.pollIntervalMs);

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