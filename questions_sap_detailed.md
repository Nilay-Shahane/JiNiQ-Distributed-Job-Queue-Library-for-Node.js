# JiNiQ — Interview Prep Q&A

## 0. How to frame the intro (30–40 seconds)

Don't recite features. Tell it as a *problem → decision → learning* arc:

> "I built JiNiQ, a Redis-backed distributed job queue, published on npm with 130+ downloads. I built it because I wanted to actually understand what happens *underneath* tools like BullMQ or Celery — not just use them. Along the way I had to solve real distributed-systems problems: how do you stop two workers from claiming the same job, how do you detect a worker that silently crashed, how do you stop high-priority jobs from starving normal ones forever. Solving those taught me atomicity, isolation, and fault-tolerance patterns hands-on, which is honestly closer to the kind of systems thinking that shows up in production ML pipelines too — feature stores, retry-safe training jobs, etc."

That last sentence is your bridge to the AI/ML role — use it, don't force it further.

---

## 1. Basic / "what is this" questions

**Q: What does JiNiQ actually do, in one sentence?**
A: It lets one part of an app (a "producer") drop a job into Redis, and separate worker processes pick it up, run it, and report success/failure — with guarantees that a job isn't lost if a worker crashes, and isn't processed twice by two workers at once.

**Q: Why did you build this instead of just using BullMQ?**
A: BullMQ already solves this well in production — I wasn't trying to replace it. I built JiNiQ *specifically* to force myself to answer the questions BullMQ hides from you: how does "claim a job" become atomic across processes? How do you know a worker died? How do you stop priority jobs from starving everything else? Using a library teaches you the API. Building one teaches you the failure modes.

**Q: Walk me through what happens when I call `queue.addJob()`.**
A: It validates the payload size (I cap it at 1MB so no one dumps huge blobs into Redis), wraps it in a `Job` domain object which generates a UUID if you didn't give one, serializes it into a flat hash, then calls into a Lua script that — atomically — checks for a duplicate ID, checks if the queue is at capacity, writes the job's data to a Redis hash, and inserts its ID into the correct sorted set (priority, normal, or delay) based on its options. All of that happens as *one* indivisible operation on Redis.

**Q: What happens when a worker picks up a job?**
A: A `Supervisor` object is continuously polling. When it has a free execution slot, it calls a Lua script that: sweeps any delayed jobs whose time has come into the normal queue, compares the oldest priority job against the oldest normal job using a scoring formula, picks a winner, then atomically moves that job into an "active" list and creates a lock key with a TTL recording who owns it. That claimed job is then handed to a `JobExecutor`, which fetches the payload, starts a heartbeat, and runs your function.

---

## 2. Concurrency, atomicity, isolation — the core of the project

**Q: How do you guarantee two workers never claim the same job?**
A: Everything that touches shared state runs as a single Lua script on Redis. Redis executes a Lua script as one atomic, uninterruptible unit — no other client's command can interleave in the middle of it, even though the script itself does multiple internal Redis operations (a `GET`, a `DEL`, an `RPUSH`, etc.). So "check if this job is available, then remove it, then lock it" happens as if it were one single command. Two workers racing for the same job will both send the same script, but Redis processes commands one at a time — one script wins the race entirely, the other simply sees the job is already gone.

**Q: Why Lua instead of Redis `MULTI`/`EXEC` transactions?**
A: This is the one distinction I make sure to get right: `MULTI`/`EXEC` guarantees a *batch* of commands executes without another client interleaving — but it can't make a *decision*. It can't do "if the lock is still owned by me, then delete it and mark complete; otherwise do nothing" — because by the time you queue the commands, you can't branch on a value you haven't read yet within the same transaction. `WATCH` + optimistic locking can express that decision, but it costs multiple round trips and needs manual retry logic on conflict. Lua lets me read a value, branch on it, and act — all inside Redis, in one round trip, with no retry loop needed in my own code.

**Q: What's an actual example of a race condition this closes?**
A: The heartbeat renewal is the clearest one. A naive version would do `GET lock` then `PEXPIRE lock` as two separate calls from Node. Between those two calls, the lock could expire, get swept, and get reassigned to a different worker — and then my `PEXPIRE` would extend a lock I no longer legitimately own, silently stealing the job back from whoever it was reassigned to, with no error on either side. Wrapping the check-then-renew in one Lua script closes that window completely.

**Q: What's the difference between atomicity and isolation in your system, concretely?**
A: Atomicity is "this multi-step operation either fully happens or doesn't happen at all" — e.g. claiming a job either moves it to active *and* creates the lock, or does neither; it can't half-execute. Isolation is "while this operation is running, no other operation can see a half-finished state" — because Redis is single-threaded for command execution, once a Lua script starts, nothing else can run until it finishes, so no other client can ever observe an in-between state.

**Q: Are these ACID transactions?**
A: Not in the full relational-database sense — there's no rollback concept, no multi-key cross-shard transaction guarantee if you were on Redis Cluster with keys on different nodes. But I get the two properties that actually matter for a queue: atomicity of each state transition, and isolation from concurrent interleaving. I'm intentionally not claiming more than that.

---

## 3. Anti-starvation / priority scheduling

**Q: How does priority scheduling work?**
A: I keep priority and normal jobs in two separate Redis sorted sets, both scored by submission timestamp. When a priority job is inserted, I subtract a fixed offset (default 10 seconds) from its score — so it *sorts* as if it arrived earlier than it actually did. At claim time, I compare `priorityScore - offset` against the oldest normal job's score, and whichever is lower wins.

**Q: Why not just give priority jobs an unconditionally lower score, like `priority * 10^10 + timestamp`?**
A: Because that's strict priority in disguise — the priority multiplier so dominates the timestamp that a normal job could wait forever if priority jobs keep arriving. The whole point of the offset model is that it's a *bounded* head start, not an absolute one: if a normal job has been sitting for longer than the offset, it mathematically starts winning again. Starvation becomes provably impossible instead of just "hopefully rare."

**Q: Could you have used one sorted set instead of two?**
A: I could compute one combined score, but then I lose the ability to reason about "is this normal job's actual wait time longer than the offset" cleanly — you'd need to bake the comparison logic into a single score formula that can't actually express a *comparison*, only a static value. Two sets, merged at read time, let me do a real comparison instead of a proxy for one.

---

## 4. Fault tolerance / crash recovery — expect deep questions here

**Q: What happens if a worker crashes mid-job?**
A: Its heartbeat — a background loop renewing that job's lock TTL roughly every third of the lock duration — simply stops. Nothing tells Redis "the worker died," there's no goodbye message. The lock just naturally expires because nobody's renewing it. Separately, a `Sweeper` runs on its own timer (independent of any job) and periodically scans the active list. For each entry, it checks: does this job's lock key still exist? If not, the owning worker is presumed dead, and the job is atomically incremented on attempt count and routed to retry or dead-letter based on `maxAttempts`.

**Q: Why lease-based (TTL) failure detection instead of an explicit "I'm alive" heartbeat table?**
A: Because Redis already solves exactly this problem — expiration. An explicit heartbeat table means I'd be rebuilding my own timeout tracker on top of a database that already has one built in and battle-tested. With TTL leases, one Redis primitive (a string key with an expiry) simultaneously represents ownership, mutual exclusion, *and* liveness. Fewer moving parts, fewer places for a bug to hide.

**Q: What's the actual worst-case time to detect a crashed worker?**
A: Bounded by `lockTTL + sweeperInterval` — the lock has to fully expire, then a sweep cycle has to run and notice. That's a tunable trade-off: shorter TTL means faster recovery but more heartbeat traffic and higher risk of falsely reclaiming a job during a brief network blip; longer TTL is safer against false positives but slower to recover a real crash.

**Q: Can a job run twice?**
A: Yes — and I'm upfront about that rather than pretending otherwise. This is an *at-least-once* system, not *exactly-once*. If a worker's heartbeat renewal gets delayed past the TTL (a GC pause, a Redis latency spike) while it's still legitimately running the job, the sweeper can reclaim it and hand it to a second worker before the first one's heartbeat call comes back and tells it "you don't own this anymore." So for a brief window, two workers could genuinely both be executing the same job.

**Q: So doesn't that break correctness?**
A: It breaks *execution* uniqueness, not *state* uniqueness — and that distinction is the important part. Every script that finalizes a job's outcome (`checkAndComplete`, `addToDelayedOrDead`) starts by checking "do I still hold the lock?" Only one of the two competing workers can pass that check; the other's call becomes a harmless no-op. So the queue's bookkeeping — is this job complete, how many attempts has it had — is always exactly correct, even if the user's actual function ran more than once. That's why I tell people to write idempotent processor functions (use the job ID as an idempotency key against external APIs) — it's the same caveat every at-least-once queue has, SQS and BullMQ included.

**Q: How do you actually stop the *duplicate execution* itself, not just the duplicate state write?**
A: `AbortController`. Every job's processor function is called with a signal. If the heartbeat ever gets a "you've lost this lock" response from Redis, it calls `.abort()` on that signal — that's the hook telling the in-flight function "stop, you're not the owner anymore." It relies on the developer's function actually respecting the signal (passing it into `fetch`, checking `signal.aborted` in a loop) — I can't force-kill an arbitrary synchronous or unresponsive function without spinning up a whole separate process/thread per job, which I deliberately chose not to do (see next section).

---

## 5. Design trade-offs — showing you understand costs, not just benefits

**Q: What would you do differently if you rebuilt this today?**
Good answers (pick 2–3, be specific):
- Add real exponential backoff between retries. Right now a failed job goes back into the retry queue with a score of `0`, meaning "eligible immediately" — so a job failing repeatedly gets hammered back-to-back instead of with increasing delay. I flagged this as a known gap in my own docs rather than pretending it wasn't there.
- The completed/dead lists (`RPUSH`) grow unboundedly — there's no TTL or trim policy, so a high-throughput queue needs an external cleanup job. I'd add capped lists or an explicit retention policy.
- There's a documented edge case in the claim script: if a job is found in a waiting queue but its lock key already exists (shouldn't normally happen, but could from a bug elsewhere), the script returns a no-op *without* removing the job from the queue — so it gets re-selected and re-rejected every single poll cycle instead of self-healing. I noticed this while writing the docs and intentionally didn't silently patch it without deciding what the *right* behavior is (retry? dead-letter? log and skip?) — that's a genuinely open design question, not an oversight I'm hiding.

**Q: Why cooperative cancellation (AbortController) instead of running each job in its own process/thread?**
A: Process/thread isolation would give me a real force-kill, but spawning a thread or child process per job in Node.js is expensive — memory and CPU overhead per job — and Node's whole strength is handling thousands of concurrent I/O-bound tasks cheaply on one event loop. Paying thread-spawn cost per job would gut the exact throughput advantage I was trying to keep. The trade-off I accepted: I can't stop a genuinely stuck `while(true)` loop, only cooperative work that respects the signal.

**Q: Why Redis instead of a real database like Postgres?**
A: A queue's access pattern is fundamentally different from typical app data — it's constant small mutations (claim, renew, complete, retry) rather than complex relational queries. Doing "find the next available job, lock it, remove it" as SQL rows means index churn and row-locking contention under high concurrency. Redis's in-memory structures and Lua scripting map onto exactly this shape of problem natively — a sorted set *is* a priority queue, a TTL string *is* a lease. The trade-off is durability: Redis isn't primarily a system-of-record database, so you have to think about persistence (AOF/snapshots) if the queue's contents need to survive a Redis restart, which I address in the docs rather than assume away.

**Q: Why not Redis Streams, which literally have consumer groups built for this?**
A: Streams give you claiming and pending-entry tracking for free, but they're strictly insertion-ordered — there's no native priority concept, so I'd need multiple streams and application-level merging anyway, which erases most of the "it's native" benefit. They also don't have native delayed-execution — you'd still need a separate sorted set alongside the stream to hold jobs until they're due, meaning Streams wouldn't actually remove complexity, just add a second structure next to the one I'd still need. I do use a Stream for one thing — the lifecycle log — because that's genuinely append-only and doesn't need ack semantics.

**Q: Why poll instead of using Redis Pub/Sub to wake workers instantly?**
A: Because Pub/Sub in Redis is at-most-once and not persisted — if a message is published while no one's subscribed (a worker restarting, a brief disconnect), it's gone forever, with no replay. If job discovery depended on that, a lost notification could mean a job sits in the queue forever with no worker ever waking up to claim it — that's a liveness bug, not just an efficiency one. Polling means workers periodically re-check Redis's actual state, so no notification can ever be "missed" — worst case, you wait for the next poll interval. I use adaptive backoff (50ms up to 2000ms) so an idle queue doesn't hammer Redis, and any successful claim immediately resets the interval back down. Pub/Sub would be a good *latency* optimization layered on top, but it shouldn't be load-bearing for correctness.

---

## 6. Comparisons — expect at least one "how is this different from X"

**Q: How is this different from BullMQ / Celery / AWS SQS / RabbitMQ?**
A: Conceptually similar goals, different scope and maturity. BullMQ solves the same problem in production with far more polish (rate limiting, flow/dependency graphs, UI dashboards). Celery is Python-native and broker-agnostic. SQS is a fully managed service — you don't see or control any of this, which is exactly why building my own version was useful pedagogically: SQS's "you get exactly-once-ish delivery and visibility timeouts" is the *same underlying idea* as my lease/heartbeat model, just hidden behind a managed API. RabbitMQ is push-based message routing rather than a pull-based claim model with retry/priority semantics baked in the way mine is. I built JiNiQ specifically to understand the mechanics none of those expose directly.

---

## 7. "Prove you actually built this" / gotcha questions

**Q: What was the hardest bug you hit?**
Have a real one ready. Good candidates from the codebase's own history to speak to honestly:
- Getting the anti-starvation math right — an early version effectively degenerated into strict priority because the offset wasn't being applied at claim time consistently, so normal jobs could starve indefinitely under sustained priority load. Fixing it meant actually tracing through what "fair" should mean mathematically, not just tweaking numbers until tests passed.
- The heartbeat/sweeper race — realizing that "worker crashed" and "worker network-partitioned but alive" look *identical* from Redis's point of view, and designing the abort-on-lease-loss mechanism so that if a partitioned worker's connectivity comes back, it stops itself instead of finishing a job that's already been reassigned.

**Q: Have you load/chaos tested this?**
A: I wrote scenario-based tests rather than formal load tests — simulating a worker process crash mid-job (`process.exit()` inside a job handler), a network blip, and an event-loop freeze (a synchronous busy-wait to simulate a hung worker) to confirm the sweeper actually recovers the job onto a second worker in each case. I haven't run it under sustained high-throughput production load — that's an honest gap, and I'd say so rather than overclaim.

**Q: Is this actually used in production anywhere?**
A: Be honest — if it's just published to npm with downloads but not running in a real production system, say exactly that: "It's published and has real downloads, but I don't have visibility into whether those are production deployments or people evaluating it — I built and tested it thoroughly myself, but I want to be upfront that it hasn't been proven under real sustained production load."

---

## 8. Bridge-to-ML questions (likely, given the role)

**Q: This is a backend/infra project — how does it relate to the ML role you're applying for?**
A: Two honest angles, don't oversell it:
1. **Systems thinking transfers.** Production ML work is full of the same shape of problem — retry-safe training/inference jobs, idempotent feature-pipeline runs, backpressure when a feature store is under load, coordinating distributed data processing. The specific domain (Redis queues) is different, but the muscle — reasoning about failure modes, race conditions, and what guarantees you actually need versus what you're claiming — is the same muscle.
2. **It's evidence of depth, not scope.** I'd rather show one thing I built and can defend under hard questioning than five tutorial-level ML projects I can't. It signals I don't stop at "it works," I ask "what happens when it doesn't."

Don't stretch further than that — don't claim it *is* an ML project. Let the interviewer draw the connection if they want to; your job is to have the honest bridge ready, not to force it.

**Q: If we asked you to add a feature-store-style read path to this, what changes?**
(Speculative/adaptive question — shows if you can reason live.) Rough shape of a good answer: you'd likely want a read replica or cache layer since feature lookups are read-heavy and latency-sensitive in a way job claiming isn't; you'd probably drop the Lua-atomicity requirement for pure reads since there's no state transition to protect; and you'd want to think about staleness tolerance, which isn't a concept that exists anywhere in JiNiQ's design. It's fine to reason out loud and land on "the design principles carry over, but the actual data-consistency requirements are different enough that I'd rethink the structure, not reuse it directly."

---

## My honest review of your prep

**Strengths to lean on:**
- You clearly understand *why*, not just *what* — the Lua-vs-MULTI distinction and the at-least-once/idempotency point are the two things that separate someone who built this from someone who copied a tutorial. Lead with those if asked open-ended "tell me about the hardest part."
- You've documented known limitations yourself (the claim-script edge case, the missing backoff, unbounded lists) — that's a genuinely strong signal of engineering maturity. Use it. Interviewers trust self-critique far more than confident overclaiming.

**Gaps to shore up before tomorrow:**
1. **Have a plain-English answer for "atomicity vs isolation" cold** — you'll almost certainly get some version of this question and it's easy to blur the two under pressure.
2. **Practice the load-testing honesty answer** — if you get asked "how do you know this scales" and you don't have a crisp "here's what I tested, here's what I didn't," it can look like you're dodging.
3. **Don't lead with npm download count as a credibility signal** — 130 downloads is a fine, honest detail, but if you lean on it like a metric of validation, a sharp interviewer will ask "how many of those are real users vs. CI bots / people evaluating it," and that's a worse position than just not bringing it up as evidence of anything beyond "I shipped something real."
4. **Given the role, spend more remaining prep time on core ML fundamentals than on this project.** You already know JiNiQ deeply — diminishing returns on more Q&A here. If your ML basics (bias-variance, overfitting, gradient descent, transformer basics, evaluation metrics) are shakier than your systems knowledge, that's where tonight's hours are worth more.