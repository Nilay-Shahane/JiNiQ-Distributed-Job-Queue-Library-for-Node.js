const BaseEvent = require('./BaseEvent');

class JobSubmitted extends BaseEvent {
  #jobId;
  #name;
  #priority;

  constructor({ jobId, name, priority }) {
    super("JOB_SUBMITTED");

    if (!jobId) throw new Error("jobId required");
    if (!name) throw new Error("name required");

    this.#jobId = jobId;
    this.#name = name;
    this.#priority = priority || "normal";

    Object.freeze(this);
  }

  static fromJob(job) {
    return new JobSubmitted({
      jobId: job.id,
      name: job.name,
      priority: job.priority
    });
  }

  toJSON() {
    return {
      ...super.baseJSON(),
      jobId: this.#jobId,
      name: this.#name,
      priority: this.#priority
    };
  }
}

module.exports = JobSubmitted;