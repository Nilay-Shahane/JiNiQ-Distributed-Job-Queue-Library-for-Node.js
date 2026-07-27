class HeartBeat{
    #stopHeartbeat = false
    #resolveSleep = null
    #timeoutId = null
    constructor(ttl,workerId , jobId , dbActions , abortFn){
        this.ttl = ttl
        this.workerId = workerId 
        this.jobId = jobId
        this.dbActions = dbActions
        this.abortFn = abortFn
    }
    sleep = (ms) => {
        return new Promise((resolve) => {
            this.#resolveSleep = resolve;
            this.#timeoutId = setTimeout(()=>{
                this.#resolveSleep = null
                this.#timeoutId = null;
                resolve()
            },ms)
        })
    }
    
    getStopHeartBeat(){
        return this.#stopHeartbeat
    }
    setStopHeartBeat(value){
        this.#stopHeartbeat = value
        if(value){
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

    randomOffset = async () =>{
        const jitter = Math.random() * 50 
        await this.sleep(jitter)
    }


    runHeartbeat = async () => {
        try {
            while (!this.#stopHeartbeat) {

                await this.sleep(this.ttl / 3)

                if (this.#stopHeartbeat) break;

                let heartBeatResp = await this.dbActions.checkAndUpdateHeartbeat()
                if(heartBeatResp!==1){
                    this.setStopHeartBeat(true) 
                    if(this.abortFn) this.abortFn()
                    break
                }

            }

        } catch (e) {
            this.setStopHeartBeat(true) 
            if(this.abortFn) this.abortFn()
        }
    }

    startHeartbeatProcess = async() =>{
        await this.randomOffset()

        let resp = await this.dbActions.checkAndUpdateHeartbeat()

        if(resp !== 1){
            this.setStopHeartBeat(true)
            if(this.abortFn) this.abortFn()
            return;
        }

        this.runHeartbeat()
    }
}

module.exports = HeartBeat