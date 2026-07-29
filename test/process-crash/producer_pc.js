const Jiniq = require("../../src/queue/Jiniq");

(async () => {

    const queue = new Jiniq("process-crash-trial-queue");

    console.log("\n📦 Producer adding welcome-email job...\n");

    const job = await queue.addJob(
        "send-welcome-email",
        {
            userId: "u_123",
            email: "user@example.com"
        },
        {
            maxAttempts: 2
        }
    );

    console.log(`✅ Job Submitted : ${job.id}`);

})();