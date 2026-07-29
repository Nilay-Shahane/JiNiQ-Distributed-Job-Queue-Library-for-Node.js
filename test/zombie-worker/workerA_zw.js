const Worker = require("../../src/worker/Worker");

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Synchronously blocks the Node.js event loop
function sleepSync(ms) {
    const end = Date.now() + ms;

    while (Date.now() < end) {
        // Busy waiting
    }
}

(async () => {

    const worker = new Worker(
        "zombie-worker-trial-queue",

        async (job) => {

            console.log("\n================================");
            console.log("Started Processing");
            console.log("================================");

            console.log("Downloading image...");
            await sleep(3000);

            console.log("\n CPU enters an infinite computation...");
            console.log(" Event Loop Frozen for 10 seconds...");
            sleepSync(10000); // Heartbeat cannot run here

            console.log("\n✅ CPU computation finished.");

            console.log("Applying AI filters...");
            await sleep(3000);

            console.log("Generating thumbnail...");
            await sleep(3000);

            console.log("Uploading output...");
            await sleep(3000);

            console.log("✅ Processing Finished");

        },

        {
            concurrency: 1,

            // Heartbeat expires during the freeze
            lockDuration: 3000,

            // Sweeper checks frequently
            sweeperInterval: 10000
        }
    );

    worker.on("job:completed", ({ jobId }) => {
        console.log(`🎉 Job Completed : ${jobId}`);
    });

    worker.on("job:failed", ({ jobId }) => {
        console.log(`❌ Job Failed : ${jobId}`);
    });

    process.on("SIGINT", async () => {
        console.log("\n💥 Simulating Machine Crash...");
        process.exit(1);
    });

    await worker.start();

})();