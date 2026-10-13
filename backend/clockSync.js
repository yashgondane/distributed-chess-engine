const { performance } = require('node:perf_hooks');

function estimateOffset(samples) {
  if (!Array.isArray(samples) || samples.length === 0) return null;
  const valid = samples.filter((sample) => Number.isFinite(sample?.T)
    && Number.isFinite(sample?.rtt) && sample.rtt >= 0 && Number.isFinite(sample?.localHw));
  if (valid.length === 0) return null;
  const best = valid.reduce((a, b) => b.rtt < a.rtt ? b : a);
  return {
    offsetMs: (best.T + best.rtt / 2) - best.localHw,
    rttMs: best.rtt,
    errorBoundMs: best.rtt / 2,
  };
}

async function takeSamples(requestTime, localHwNow = Date.now, sampleCount = 5, spacingMs = 50) {
  const samples = [];
  for (let i = 0; i < sampleCount; i += 1) {
    const p0 = performance.now();
    const reply = await requestTime();
    const p1 = performance.now();
    if (reply && Number.isFinite(reply.t)) {
      samples.push({ T: reply.t, rtt: p1 - p0, localHw: localHwNow() });
    }
    if (i + 1 < sampleCount) await new Promise((resolve) => setTimeout(resolve, spacingMs));
  }
  return samples;
}

module.exports = { estimateOffset, takeSamples };
