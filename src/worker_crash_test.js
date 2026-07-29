const Jiniq = require('./queue/Jiniq');
const Worker = require('./worker/Worker');

async function runRealWorldRetryDemo() {
    const queueName = 'email-notifications';

    // 1. Initialize the Queue (Producer)
    const queue = new Jiniq(queueName);

    // 2. Setup the Worker (Consumer)
    // We use a Map to simulate a "flaky" third-party API that fails the first time 
    // it sees a specific job, but succeeds the second time.
    const failureTracker = new Map();

    const worker = new Worker(queueName, async (job) => {
        console.log(`[Worker] Picked up Job ID: ${job.id}`);

        // Track how many times we've tried this specific job
        const attempts = failureTracker.get(job.id) || 0;
        
        if (attempts === 0) {
            failureTracker.set(job.id, 1);
            console.log(`[Worker] Simulating API connection drop for Job ${job.id}...`);
            
            // USER POV: The developer's code just throws a standard JavaScript error.
            // They don't need to know about Redis, Lua, or Sweepers.
            throw new Error("Connection reset by peer (SendGrid API)");
        }

        console.log(`[Worker] Attempt #2 for Job ${job.id} - Sending email successfully!`);
        
        // Simulate some async work
        await new Promise(resolve => setTimeout(resolve, 300));
        
        console.log(`[Worker] Job ${job.id} Completed.`);
    }, {
        concurrency: 1 
    });

    // Listen to worker events
    worker.on('job:completed', (data) => console.log(`[Event] Job Completed: ${data.jobId}`));
    worker.on('job:failed', (data) => console.log(`[Event] Job Failed/Retrying: ${data.jobId}`));

    // Start listening
    await worker.start();

    // 3. Producer adds the job
    // We do NOT pass a jobId. We let IdGenerator.generate() do its job.
    // We DO pass maxAttempts to tell JiNiQ to retry it.
    console.log(`[Producer] Adding job to queue...`);
    const submittedJob = await queue.addJob(
        'send-welcome-email',
        { userId: 'u_123', email: 'user@example.com' },
        { maxAttempts: 2 } 
    );
    
    console.log(`[Producer] JiNiQ auto-generated ID: ${submittedJob.id}`);

    // Let the demo run for a few seconds before shutting down
    setTimeout(async () => {
        await worker.stop();
        await queue.close(); // Clean up producer connections
        process.exit(0);
    }, 3000);
}

runRealWorldRetryDemo().catch(console.error);