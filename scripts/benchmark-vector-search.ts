import { performance } from "node:perf_hooks";
import { cosineSimilarity } from "../src/embeddings.js";

const candidateCount = intArg("--candidates", 20_000);
const dimensions = intArg("--dimensions", 256);
const runs = intArg("--runs", 25);
const targetP95Ms = intArg("--target-p95-ms", 250);

const query = normalizedVector(dimensions, 1);
const candidates = Array.from({ length: candidateCount }, (_, index) => normalizedVector(dimensions, index + 2));
const durations: number[] = [];

for (let run = 0; run < runs; run += 1) {
  const started = performance.now();
  let best = -Infinity;
  for (const candidate of candidates) {
    const score = cosineSimilarity(query, candidate);
    if (score > best) {
      best = score;
    }
  }
  durations.push(performance.now() - started);
}

durations.sort((left, right) => left - right);
const p95 = durations[Math.max(0, Math.ceil(durations.length * 0.95) - 1)] ?? 0;
const rssMb = process.memoryUsage().rss / (1024 * 1024);
const ok = p95 <= targetP95Ms;

console.log(
  JSON.stringify(
    {
      ok,
      candidateCount,
      dimensions,
      runs,
      targetP95Ms,
      p95Ms: Number(p95.toFixed(2)),
      rssMb: Number(rssMb.toFixed(2)),
      note: "Synthetic cosine loop only; use before raising TELEGRAM_EMBEDDINGS_VECTOR_CANDIDATE_LIMIT.",
    },
    null,
    2,
  ),
);

if (!ok) {
  process.exitCode = 1;
}

function normalizedVector(length: number, seed: number): Float32Array {
  const values = new Float32Array(length);
  let sum = 0;
  let state = seed;
  for (let index = 0; index < length; index += 1) {
    state = (state * 1664525 + 1013904223) >>> 0;
    const value = (state / 0xffffffff) * 2 - 1;
    values[index] = value;
    sum += value * value;
  }
  const norm = Math.sqrt(sum) || 1;
  for (let index = 0; index < values.length; index += 1) {
    values[index] /= norm;
  }
  return values;
}

function intArg(name: string, fallback: number): number {
  const index = process.argv.indexOf(name);
  if (index < 0) {
    return fallback;
  }
  const parsed = Number(process.argv[index + 1]);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}
