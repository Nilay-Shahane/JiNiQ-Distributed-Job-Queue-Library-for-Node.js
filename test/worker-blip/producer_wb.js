const Jiniq = require("../../src/queue/Jiniq");

(async () => {

    const queue = new Jiniq("worker-blip-trial-queue");

    console.log("\n📦 Producer adding image-processing job...\n");

    const job = await queue.addJob(
        "resize-image",
        {
            image: "profile.png"
        },
        { maxAttempts: 2 } 
    );

    console.log(`✅ Job Submitted : ${job.id}`);

})();