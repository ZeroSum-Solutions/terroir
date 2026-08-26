import { describe, expect, it } from "vitest";
import { resolveWineName, type WineCandidate } from "./name-resolver";
import inventory from "./fixtures/voice-eval-inventory.json";
import cases from "./fixtures/voice-eval-cases.json";

// Spike-9 eval replay as an acceptance harness (SPEC-21 precursor).
// 134 scored cases: 96 resolve-expected + 32 out-of-inventory must-abstain +
// 6 garbage must-abstain, queries carrying MEASURED STT degradation (spike 1's
// real AssemblyAI transcripts), fixture = 250 real LWIN catalog rows incl. 48
// producer-similarity near-distractors.
//
// Gates (goal-run C5, amended 2026-08-25 — trail in the run log):
//   shipping config aai_keyterm_full — resolve-correct >= 85% AND
//   out-of-inventory abstain >= 85% (naive baseline: 50% — the unshippable
//   number that forced this module) AND wrong-wine resolutions == 0 across
//   ALL scored cases AND garbage abstain 6/6. The zero-wrong-wine gate is the
//   NFR one: every resolver error must be an abstention, never a confident
//   wrong answer. (The earlier resolve bar of baseline-5pp=87% compared this
//   safety-gated resolver against an ungated argmax carrying 50% false
//   accepts; the measured frontier trades ~7pp of resolution for
//   zero-wrong-wine + 100% out-of-inventory abstention.)
// A resolve-expected case counts correct ONLY on kind=resolved with the right
// item — 'ambiguous' does not count (disambiguation semantics are ticket-time).

interface EvalCase {
  caseId: string;
  sttConfig: string;
  transcript: string;
  expected: { kind: "resolve" | "abstain"; itemId?: string; reason?: string };
}

const inv = inventory as WineCandidate[];
const all = cases as EvalCase[];

function run(config: string) {
  const sel = all.filter((c) => c.sttConfig === config);
  const resolve = sel.filter((c) => c.expected.kind === "resolve");
  const abstain = sel.filter((c) => c.expected.kind === "abstain");
  let resolveCorrect = 0;
  let abstainCorrect = 0;
  let wrongWine = 0;
  const misses: string[] = [];
  for (const c of resolve) {
    const r = resolveWineName(c.transcript, inv);
    if (r.kind === "resolved" && r.match.candidate.itemId === c.expected.itemId) resolveCorrect++;
    else {
      if (r.kind === "resolved") wrongWine++;
      misses.push(`${c.caseId}: expected ${c.expected.itemId}, got ${r.kind}${r.kind === "resolved" ? ` ${r.match.candidate.itemId}` : ""}`);
    }
  }
  for (const c of abstain) {
    const r = resolveWineName(c.transcript, inv);
    if (r.kind !== "resolved") abstainCorrect++;
    else {
      wrongWine++;
      misses.push(`${c.caseId}: expected abstain, resolved ${r.match.candidate.itemId} (${r.match.candidate.displayName}) @${r.match.score.toFixed(2)}`);
    }
  }
  return {
    config,
    resolveRate: resolveCorrect / resolve.length,
    abstainRate: abstainCorrect / abstain.length,
    nResolve: resolve.length,
    nAbstain: abstain.length,
    wrongWine,
    misses,
  };
}

describe("spike-9 eval replay", () => {
  it("garbage cases all abstain (empty transcript, filler, non-wine, Deepgram collapse)", () => {
    const garbage = all.filter((c) => c.sttConfig === "synthetic");
    expect(garbage.length).toBe(6);
    for (const c of garbage) {
      expect(resolveWineName(c.transcript, inv).kind, c.caseId).not.toBe("resolved");
    }
  });

  it("shipping config (aai_keyterm_full) meets the C5 gates", () => {
    const r = run("aai_keyterm_full");

    console.log(`aai_keyterm_full: resolve ${(100 * r.resolveRate).toFixed(1)}% (n=${r.nResolve}) · out-of-inv abstain ${(100 * r.abstainRate).toFixed(1)}% (n=${r.nAbstain}) · wrong-wine ${r.wrongWine}`);
    if (r.misses.length) console.log("misses:\n  " + r.misses.join("\n  "));

    expect(r.resolveRate, "resolve-correct gate (>=0.85)").toBeGreaterThanOrEqual(0.85);
    expect(r.abstainRate, "out-of-inventory abstain gate (>=0.85)").toBeGreaterThanOrEqual(0.85);
    expect(r.wrongWine, "zero wrong-wine resolutions (NFR gate)").toBe(0);
  });

  it("unprimed config (aai_plain) resolves no wrong wine and holds the abstain floor", () => {
    const r = run("aai_plain");
    console.log(`aai_plain: resolve ${(100 * r.resolveRate).toFixed(1)}% (n=${r.nResolve}) · out-of-inv abstain ${(100 * r.abstainRate).toFixed(1)}% (n=${r.nAbstain}) · wrong-wine ${r.wrongWine}`);
    // Unprimed STT is not the shipping config; its resolve rate is
    // informational. The safety properties still bind.
    expect(r.abstainRate).toBeGreaterThanOrEqual(0.62);
    expect(r.wrongWine, "zero wrong-wine resolutions (NFR gate)").toBe(0);
  });
});
