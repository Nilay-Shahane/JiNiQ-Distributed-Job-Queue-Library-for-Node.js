class JobExecutor{
    constructor(Heartbeat , jobId , workerId, ttl ,maxTimeoutMs ,  userProcess , dbActions){
        this.ttl = ttl
        this.maxTimeoutMs = maxTimeoutMs
        this.workerId = workerId 
        this.jobId = jobId 
        this.userProcess = userProcess
        this.Heartbeat = Heartbeat
        this.dbActions = dbActions
    }


    beginWork = async () => {
        const controller = new AbortController();
        const newHeartbeatInstance = new this.Heartbeat(this.ttl, this.workerId, this.jobId, this.dbActions, () => controller.abort());
        let timeoutId;
        
        // Hoisted so the catch block can send the payload to the dashboard if it crashes
        let payload = null; 

        try {
            payload = await this.dbActions.getPayload(this.jobId);
            
            await newHeartbeatInstance.startHeartbeatProcess();
            
            const timeoutPromise = new Promise((_, reject) => {
                timeoutId = setTimeout(() => {
                    controller.abort();
                    reject(new Error(`JOB_TIMEOUT: Process exceeded max execution time of ${this.maxTimeoutMs}ms`));
                }, this.maxTimeoutMs);
            });

            const resp = await Promise.race([
                this.userProcess(payload, controller.signal),
                timeoutPromise
            ]);

            clearTimeout(timeoutId); 

            try {
                const completed = await this.dbActions.addToCompleted();

                if(completed !== 1){
                    console.warn(
                        `Job ${this.jobId} completion rejected. Ownership lost`
                    );
                    return resp;
                }

                await this.dbActions.publishLog(
                    'Completed',
                    payload
                );
                
            } catch (dbErr) {
                console.error(`CRITICAL: Job ${this.jobId} succeeded but failed to mark as complete.`, dbErr);
            }

            return resp; 

        } catch (e) {
            clearTimeout(timeoutId);
            controller.abort(); 

            try {
                await this.dbActions.addToFailed(e);
                
                // 🔴 ADDED: Broadcast crash and stack trace to the React Dashboard
               await this.dbActions.publishLog('Failed', payload, e.stack || e.message)
            } catch (dbErr) {
                console.error(`Failed to record failed job: ${dbErr}`);
            }
            
            // To answer your question: Yes, keep this!
            throw e; 
        } finally {
            newHeartbeatInstance.setStopHeartBeat(true);
        }
    }
}

module.exports = JobExecutor