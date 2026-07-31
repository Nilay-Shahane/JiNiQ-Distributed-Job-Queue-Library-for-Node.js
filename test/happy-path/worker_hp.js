const Worker = require("../../src/worker/Worker");

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

(async () => {

    const worker = new Worker(
        "happy-path-trial-queue",

        async (job) => {

            console.log("\n================================");
            console.log("Started Processing");
            console.log("================================");

            console.log("resizing image...");
            await sleep(12000);


            console.log("✅ Processing Finished");

        },

        {
            concurrency: 1,

            // Heartbeat expires quickly
            lockDuration: 7000,

            // Sweeper checks frequently
            sweeperInterval: 3000
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