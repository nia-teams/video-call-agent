/** Compute levels from actual PCM samples, never from packet/byte counts. */
export function measure(samples) {
  let square = 0, peak = 0, count = 0;
  for (const value of samples) { if (!Number.isFinite(value)) continue; square += value * value; peak = Math.max(peak, Math.abs(value)); count++; }
  const rms = count ? Math.sqrt(square / count) : 0;
  const db = value => Math.max(-96, 20 * Math.log10(Math.max(1e-12, value)));
  return { rms: db(rms), peak: db(peak), signal: rms > 0.001, clipped: peak >= 0.99 };
}
