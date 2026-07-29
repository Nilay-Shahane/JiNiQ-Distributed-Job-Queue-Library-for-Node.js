const Worker = require("../../src/worker/Worker");

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

(async () => {

    const worker = new Worker(
        "worker-blip-trial-queue",

        async (job) => {

            console.log("\n================================");
            console.log("Started Processing");
            console.log("================================");

            console.log("Downloading image...");
            await sleep(3000);

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

            // Heartbeat expires quickly
            lockDuration: 3000,

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