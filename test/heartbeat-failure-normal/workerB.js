const Worker = require("../../src/worker/Worker");

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {

    console.log("Starting Worker B...");

    const worker = new Worker(

        "image-processing",

        async (job) => {

            console.log("\n==============================");
            console.log("Worker B");
            console.log("==============================");

            console.log(`Recovered Job : ${job.id}`);

            console.log("Processing Image...");
            await sleep(3000);

            console.log("Uploading Output...");
            await sleep(1000);

            console.log(`✅ Job ${job.id} Completed`);

        },

        {
            concurrency: 1
        }

    );

    worker.on("job:completed", ({ jobId }) => {

        console.log(`\n🎉 Recovery Successful : ${jobId}`);

    });

    await worker.start();

})();