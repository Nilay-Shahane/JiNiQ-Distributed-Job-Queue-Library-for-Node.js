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
                    await this.dbActions.publishLog(
                        'Completed',
                        payload
                    );
                }
                

            } catch (dbErr) {

                console.error(
                    `[Job ${this.jobId}] Failed to persist completion`
                );
                console.error(dbErr);

            }

            console.log(`\n[Job ${this.jobId}] ✓ Completed\n`);

            return resp;

        } catch (e) {

            clearTimeout(timeoutId);

            controller.abort();
            if (e.message === "LEASE_LOST") {

                console.warn(
                    `[Job ${this.jobId}] Lease lost. Discarding stale result.`
                );

                throw e;
            }

            try {

                await this.dbActions.addToFailed(e);

                await this.dbActions.publishLog(
                    'Failed',
                    payload,
                    e.stack || e.message
                );

            } catch (dbErr) {

                console.error(
                    `[Job ${this.jobId}] Failed to persist failure`
                );
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