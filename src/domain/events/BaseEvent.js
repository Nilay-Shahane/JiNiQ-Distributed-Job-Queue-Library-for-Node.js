const crypto = require('crypto');

class BaseEvent {
  #eventId;
  #createdAt;
  #eventType;

  constructor(eventType) {
    if (new.target === BaseEvent) {
      throw new Error("BaseEvent is abstract and cannot be instantiated directly");
    }

    if (!eventType) throw new Error("eventType is required");

    this.#eventId = crypto.randomUUID();
    this.#createdAt = Date.now();
    this.#eventType = eventType;
  }

  get eventId() { return this.#eventId; }
  get createdAt() { return this.#createdAt; }
  get eventType() { return this.#eventType; }

  baseJSON() {
    return {
      eventId: this.#eventId,
      eventType: this.#eventType,
      createdAt: this.#createdAt
    };
  }

  // simulate abstract method
  toJSON() {
    throw new Error("toJSON() must be implemented by subclass");
  }
}

module.exports = BaseEvent;