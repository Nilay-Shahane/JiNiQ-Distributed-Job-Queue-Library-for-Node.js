const Jiniq = require('./queue/Jiniq'); // Adjust this if your export is different
const JiniqWorker = require('./worker/Worker'); // Adjust this if your export is different

async function runChaosTest() {
    console.log("🌪️ Starting the Chaos Test...");
    
    // Assuming your Jiniq class is instantiated like this
    const emailQueue = new Jiniq('email-queue');

    // 1. Flood the queue with jobs (Passing the jobName as the first string argument!)
    console.log("📦 Pushing jobs to the waitlist...");
    
    await emailQueue.addJob("send_welcome", { type: "welcome", to: "user1@test.com", action: "success" });
    await emailQueue.addJob("send_invoice", { type: "invoice", to: "user2@test.com", action: "slow" });
    await emailQueue.addJob("send_alert",   { type: "alert", to: "admin@test.com", action: "crash" });
    await emailQueue.addJob("send_report",  { type: "report", to: "boss@test.com", action: "timeout" });
    await emailQueue.addJob("send_digest",  { type: "digest", to: "user3@test.com", action: "success" });

    // 2. Define a chaotic processing function
    const chaoticProcessor = async (payload) => {
        console.log(`\n⚙️ Processing job: ${payload.action}`);

        if (payload.action === 'success') {
            return "Email sent successfully!";
        }
        
        if (payload.action === 'slow') {
            // Wait 4 seconds to force the dashboard to show it as 'Active'
            await new Promise(resolve => setTimeout(resolve, 4000));
            return "Email sent, but it took a while.";
        }

        if (payload.action === 'crash') {
            // Intentionally throw an error to test the Failed state and stack trace
            throw new Error("SMTP_CONNECTION_REFUSED: Could not connect to mail server on port 587.");
        }

        if (payload.action === 'timeout') {
            // Intentionally hang for 15 seconds (assuming your maxTimeoutMs is around 5-10s)
            await new Promise(resolve => setTimeout(resolve, 15000));
            return "This will never be reached because Jiniq will kill it first.";
        }
    };

    // 3. Start the worker to consume the jobs
    console.log("👷 Starting worker...");
    
    // Make sure this matches your worker's constructor signature!
    const worker = new JiniqWorker('email-queue', chaoticProcessor, {
        maxTimeoutMs: 5000 
    });

    worker.start();
}

runChaosTest();