const JobStatus = Object.freeze({
    WAITING:'waiting',
    ACTIVE: 'active',
    COMPLETED: 'completed',
    FAILED: 'failed',
    DEAD: 'dead',
    DELAYED: 'delayed',
})

module.exports = JobStatus;