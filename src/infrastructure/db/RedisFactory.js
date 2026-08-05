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