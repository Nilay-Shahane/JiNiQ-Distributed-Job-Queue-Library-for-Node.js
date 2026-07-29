const Worker = require("../../src/worker/Worker");

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {

    const worker = new Worker(
        "image-processing",

        async (job) => {

            console.log("\n==============================");
            console.log("Worker A");
            console.log("==============================");

            console.log(`Claimed Job : ${job.id}`);

            console.log("Downloading Image...");
            await sleep(2000);

            console.log("Applying AI Filters...");
            await sleep(3000);

            console.log("\n💥 MACHINE CRASHED");
            console.log("Heartbeat stops...");
            console.log("Lease will expire...");
            console.log();

            process.exit(1);

        },

        {
            concurrency: 1
        }

    );

    await worker.start();

})();