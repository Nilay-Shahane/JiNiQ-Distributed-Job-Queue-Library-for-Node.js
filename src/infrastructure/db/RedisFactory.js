const RedisDB = require('./RedisDB');
class RedisFactory {
    static #manager;
    static #fetcher;

    static initialize(config = {}) {
        if (!this.#manager) {
            this.#manager = new RedisDB(config);
            this.#fetcher = new RedisDB(config);
        }
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
}

module.exports = RedisFactory;