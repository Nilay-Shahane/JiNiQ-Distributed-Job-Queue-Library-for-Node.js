const JobStatus = require('./JobStatus')
class Job {
  #id;
  #name;
  #payload;
  #priority;
  #runAt;
  #status;
  #attempt;
  #maxAttempts;
  #delay;
  #ttl;
 #timeout;

  #createdAt;
  #updatedAt;
  #startedAt;
  #completedAt;
  #failedAt;
  #deadAt;

  #result;
  #failedReason;
  #stackTrace;
  #workerId;
  #finishedOn;

  constructor({
    id,
    name,
    payload = {},
    priority = "normal",
    delay = null,
    runAt = null,
    maxAttempts = 0,
    ttl = 30000,
    timeout = null
  } = {}) {

    if (!id) throw new Error("Job must have id");
    if (!name) throw new Error("Job must have name");

    const validPriorities = ["high", "normal"];
    let validatedPriority = priority;
    if (!validPriorities.includes(priority)) {
      console.warn(`[Jiniq Warning] Invalid priority "${priority}" passed for job "${name}". Defaulting to "normal".`);
      validatedPriority = "normal";
    }

    // assign to private fields
    this.#id = id;
    this.#name = name;
    this.#payload = payload;
    this.#priority = validatedPriority;
    this.#delay = delay;
    this.#ttl = ttl;
    this.#timeout = timeout;
    this.#runAt = runAt;

    // state
    this.#status = JobStatus.WAITING;
    this.#attempt = 0;
    this.#maxAttempts = maxAttempts;

    // timestamps
    this.#createdAt = Date.now();
    this.#updatedAt = Date.now();
    this.#startedAt = null;
    this.#completedAt = null;
    this.#failedAt = null;
    this.#deadAt = null;

    // execution metadata
    this.#result = null;
    this.#failedReason = null;
    this.#stackTrace = null;
    this.#workerId = null;
    this.#finishedOn = null;
  }

//this class i am defing to hash payload and other data different class wasnt created because if would be slow create overhead trigger garbage collection  even mongodb follow this even if domain rule is broken
toRedisHash() {
    return {
      id: this.#id,
      name: this.#name,
      payload: JSON.stringify(this.#payload), 
      priority: this.#priority,
      delay: this.#delay || 0,
      runAt: this.#runAt || 0,
      ttl: this.#ttl,
      timeout: this.#timeout || 0,
      
      status: this.#status,
      attempt: this.#attempt,
      maxAttempts: this.#maxAttempts,
      
      createdAt: this.#createdAt,
      updatedAt: this.#updatedAt,
      startedAt: this.#startedAt || '',
      completedAt: this.#completedAt || '',
      failedAt: this.#failedAt || '',
      deadAt: this.#deadAt || '',
      
      result: this.#result ? JSON.stringify(this.#result) : '',
      failedReason: this.#failedReason || '',
      stackTrace: this.#stackTrace || '',
      workerId: this.#workerId || '',
      finishedOn: this.#finishedOn || ''
    };
  }
  
  get id() { return this.#id; }
  get name() { return this.#name; }
  get payload() {return this.#payload}
  get priority() { return this.#priority; }
  get delay() {return this.#delay}
  get ttl(){return this.#ttl;}
  get timeout(){return this.#timeout;}
  get runAt() { return this.#runAt; }

  get status() { return this.#status; }
  get attempt() { return this.#attempt; }
  get maxAttempts() {return this.#maxAttempts;}

  get createdAt() { return this.#createdAt; }
  get updatedAt() { return this.#updatedAt; }
  get startedAt() { return this.#startedAt; }
  get completedAt() { return this.#completedAt; }
  get failedAt() { return this.#failedAt; }
  get deadAt() { return this.#deadAt; }

  get result() { return this.#result; }
  get failedReason() { return this.#failedReason; }
  get stackTrace() { return this.#stackTrace; }
  get workerId() { return this.#workerId; }
  get finishedOn() { return this.#finishedOn; }
  //now the below method is static  beacause we dont need to create instnace of a job to convert into hash its a already existing job we convert
  static fromRedisHash(rawHash) {
    const job = new Job({
      id: rawHash.id,
      name: rawHash.name,
      payload: rawHash.payload ? JSON.parse(rawHash.payload) : {},
      priority: rawHash.priority,
      delay: Number(rawHash.delay) || null,
      runAt: Number(rawHash.runAt) || null,
      maxAttempts: Number(rawHash.maxAttempts) || 0,
      ttl: Number(rawHash.ttl) || 30000,
      timeout: Number(rawHash.timeout) || null
    });
    
    //atrribute that are not set in constructor
    job.#status = rawHash.status;
    job.#attempt = Number(rawHash.attempt) || 0;
    job.#createdAt = Number(rawHash.createdAt);
    job.#updatedAt = Number(rawHash.updatedAt);
    job.#startedAt = Number(rawHash.startedAt) || null;
    job.#completedAt = Number(rawHash.completedAt) || null;
    job.#failedAt = Number(rawHash.failedAt) || null;
    job.#deadAt = Number(rawHash.deadAt) || null;
    job.#result = rawHash.result ? JSON.parse(rawHash.result) : null;
    job.#failedReason = rawHash.failedReason || null;
    job.#stackTrace = rawHash.stackTrace || null;
    job.#workerId = rawHash.workerId || null;
    job.#finishedOn = rawHash.finishedOn || null;

    return job;
  }

}

module.exports = Job