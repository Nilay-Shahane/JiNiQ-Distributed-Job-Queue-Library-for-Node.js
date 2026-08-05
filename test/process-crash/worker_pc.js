const Worker = require("../../src/worker/Worker");

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Simulates a flaky external API.
// First attempt fails.
// Second attempt succeeds.
const failureTracker = new Map();

(async () => {

    const worker = new Worker(

        "process-crash-trial-queue",

        async (job) => {

            console.log("\n================================");
            console.log(`📨 Processing Job : ${job.id}`);
            console.log("================================");

            const attempts = failureTracker.get(job.id) || 0;

            if (attempts === 0) {

                failureTracker.set(job.id, 1);

                console.log("Connecting to Email Service...");
                await sleep(5000);

                console.log("Connection Lost!");
                throw new Error("Connection reset by peer (SendGrid API)");
            }

            console.log("Retry Attempt...");
            await sleep(7000);

            console.log("Sending Welcome Email...");
            await sleep(2500);

            console.log("✅ Email Sent Successfully!");

        },

        {
            concurrency: 1,

            lockDuration: 7000,

            sweeperInterval: 3000
        }

    );


    await worker.start();

})();