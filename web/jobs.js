/**
 * jobs.js — Cola de trabajos en memoria (descargas, escaneos).
 * Sin persistencia: si reinicias el server, se pierden.
 */
const { randomUUID } = require('crypto');
const jobs = new Map();

function createJob(type, meta = {}) {
  const id = randomUUID();
  const job = {
    id, type, ...meta,
    status: 'pending',   // pending | running | done | error
    progress: 0,
    total: 0,
    result: null,
    error: null,
    createdAt: Date.now(),
    finishedAt: null,
  };
  jobs.set(id, job);
  return id;
}

function updateJob(id, patch) {
  const job = jobs.get(id);
  if (!job) return;
  Object.assign(job, patch);
  if (patch.status === 'done' || patch.status === 'error') {
    job.finishedAt = Date.now();
  }
}

function getJob(id) { return jobs.get(id) || null; }

function cleanup(maxAgeMs = 60 * 60 * 1000) {
  const now = Date.now();
  for (const [id, job] of jobs) {
    if (job.finishedAt && now - job.finishedAt > maxAgeMs) jobs.delete(id);
  }
}
setInterval(cleanup, 10 * 60 * 1000).unref();

module.exports = { createJob, updateJob, getJob };
