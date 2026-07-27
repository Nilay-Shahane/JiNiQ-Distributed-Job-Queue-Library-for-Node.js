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
            numberOfKeys: 5,
            lua:addJobLua
        });

        this.client.defineCommand('claimNextJob', {
            numberOfKeys: 5,
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