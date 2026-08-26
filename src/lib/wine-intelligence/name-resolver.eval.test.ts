import { describe, expect, it } from "vitest";
import { resolveWineName, type WineCandidate } from "./name-resolver";
import inventory from "./fixtures/voice-eval-inventory.json";
import cases from "./fixtures/voice-eval-cases.json";

// Spike-9 eval replay — the TUNING harness for the resolver rule (SPEC-21
// precursor). 134 scored cases: 96 resolve-expected + 32 out-of-inventory
// must-abstain + 6 garbage must-abstain, queries carrying MEASURED STT
// degradation (spike 1's real AssemblyAI transcripts), fixture = 250 real
// LWIN catalog rows incl. 48 producer-similarity near-distractors.
//
// EVIDENTIARY STATUS (per the 2026-08-25 GPT-5.6 Sol audit): the v1→v5
// decision rule was ITERATED against these cases, so they are tuning data,
// not sealed acceptance evidence. The numbers asserted below are exact
// SNAPSHOTS of the frozen rule on the frozen fixture — any rule change that
// moves any bucket must be a conscious, reviewed decision. Production
// acceptance is SPEC-21's untouched partner-weighted holdout (human/noisy
// speech, categories, ambiguity, location semantics — none of which this
// harness covers).
//
// Metric ledger (recorded per the audit — none of these supersede the others):
//   naive spike-9 baseline:          92% resolution / 50% OOI false-accept
//   original goal-run gate (missed): resolve >= 87% (= baseline − 5pp)
//   frozen v5 rule (this file):      25/48 resolved + 16/48 disambiguated
//                                    (truth always in the list) + 7 abstained
//                                    = 41/48 coverage, 16/16 OOI pure
//                                    abstentions, 0 wrong-wine on BOTH configs.
// A resolve-expected case scores as: resolved-correct (kind=resolved, right
// item), disambiguated-with-truth (kind=ambiguous AND the expected item is in
// the candidate list — SPEC-20's disambiguation-list product answer for
// same-producer multi-bottling states), abstained, or WRONG-WINE (resolved to
// the wrong item, or ambiguous without the truth — both count as wrong).

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
  let resolvedCorrect = 0;
  let disambiguatedWithTruth = 0;
  let abstained = 0;
  let wrongWine = 0;
  let ooiAbstain = 0;
  const detail: string[] = [];
  for (const c of resolve) {
    const r = resolveWineName(c.transcript, inv);
    if (r.kind === "resolved") {
      if (r.match.candidate.itemId === c.expected.itemId) resolvedCorrect++;
      else {
        wrongWine++;
        detail.push(`WRONG ${c.caseId}: resolved ${r.match.candidate.itemId}, expected ${c.expected.itemId}`);
      }
    } else if (r.kind === "ambiguous") {
      if (r.candidates.some((s) => s.candidate.itemId === c.expected.itemId)) disambiguatedWithTruth++;
      else {
        wrongWine++;
        detail.push(`WRONG ${c.caseId}: ambiguous without truth`);
      }
    } else {
      abstained++;
    }
  }
  for (const c of abstain) {
    const r = resolveWineName(c.transcript, inv);
    if (r.kind === "abstain") ooiAbstain++;
    else detail.push(`WRONG ${c.caseId}: expected abstain, got ${r.kind}`);
  }
  if (detail.length) console.log(detail.join("\n"));
  console.log(
    `${config}: resolved ${resolvedCorrect}/${resolve.length} · disambiguated(truth-in-list) ${disambiguatedWithTruth} · abstained ${abstained} · wrong-wine ${wrongWine} · OOI pure-abstain ${ooiAbstain}/${abstain.length}`,
  );
  return { resolvedCorrect, disambiguatedWithTruth, abstained, wrongWine, ooiAbstain, nResolve: resolve.length, nAbstain: abstain.length };
}

// Frozen map of every ambiguous outcome on the tuning fixture: caseId ->
// sorted candidate itemIds. Regenerate consciously (scratch script in the run
// log) whenever the rule changes; a drifted pair set must be reviewed, not
// re-recorded blindly.
const FROZEN_AMBIGUOUS_PAIRS: Record<string, string> = {
  U09_en_aai_plain: "I006+I037", U09_en_aai_keyterm_full: "I006+I037",
  U09_nat_aai_plain: "I006+I037", U09_nat_aai_keyterm_full: "I006+I037",
  U12_en_aai_keyterm_full: "I007+I039", U12_nat_aai_keyterm_full: "I007+I039",
  U14_en_aai_plain: "I009+I043", U14_en_aai_keyterm_full: "I009+I043",
  U14_nat_aai_plain: "I009+I043", U14_nat_aai_keyterm_full: "I009+I043",
  U30_en_aai_plain: "I016+I057", U30_en_aai_keyterm_full: "I016+I057",
  U30_nat_aai_plain: "I016+I057", U30_nat_aai_keyterm_full: "I016+I057",
  U33_en_aai_keyterm_full: "I018+I060", U33_nat_aai_keyterm_full: "I018+I060",
  U36_en_aai_plain: "I020+I065", U36_en_aai_keyterm_full: "I020+I065",
  U36_nat_aai_plain: "I020+I065", U36_nat_aai_keyterm_full: "I020+I065",
  U42_en_aai_plain: "I022+I069", U42_en_aai_keyterm_full: "I022+I069",
  U42_nat_aai_plain: "I022+I069", U42_nat_aai_keyterm_full: "I022+I069",
  U45_en_aai_plain: "I023+I070", U45_en_aai_keyterm_full: "I023+I070",
  U45_nat_aai_plain: "I023+I070", U45_nat_aai_keyterm_full: "I023+I070",
};

describe("EV-VWP-21.1: spike-9 eval replay (tuning-fixture snapshot gates)", () => {
  it("every ambiguous outcome is exactly the frozen same-producer pair containing the truth", () => {
    const seen: Record<string, string> = {};
    for (const c of all.filter((x) => x.expected.kind === "resolve")) {
      const r = resolveWineName(c.transcript, inv);
      if (r.kind !== "ambiguous") continue;
      expect(r.candidates.length, `${c.caseId} candidate count`).toBe(2);
      const [a, b] = r.candidates;
      expect(a.candidate.producer, `${c.caseId} same producer`).toBe(b.candidate.producer);
      expect(
        r.candidates.some((s) => s.candidate.itemId === c.expected.itemId),
        `${c.caseId} truth in list`,
      ).toBe(true);
      seen[c.caseId] = r.candidates.map((s) => s.candidate.itemId).sort().join("+");
    }
    expect(seen).toEqual(FROZEN_AMBIGUOUS_PAIRS);
  });

  it("fixture shape is the frozen one", () => {
    expect(all.length).toBe(134);
    expect(inv.length).toBe(250);
  });

  it("garbage cases: exactly 6, every one a pure abstention", () => {
    const garbage = all.filter((c) => c.sttConfig === "synthetic");
    expect(garbage.length).toBe(6);
    for (const c of garbage) {
      expect(resolveWineName(c.transcript, inv).kind, c.caseId).toBe("abstain");
    }
  });

  it("shipping config (aai_keyterm_full): exact snapshot + safety gates", () => {
    const r = run("aai_keyterm_full");
    expect(r.nResolve).toBe(48);
    expect(r.nAbstain).toBe(16);
    // Safety gates (the NFR ones — hard):
    expect(r.wrongWine, "zero wrong-wine (incl. truthless ambiguity)").toBe(0);
    expect(r.ooiAbstain, "out-of-inventory pure abstentions").toBe(16);
    // Frozen-rule snapshot (move any of these only with a reviewed rule change):
    expect(r.resolvedCorrect).toBe(25);
    expect(r.disambiguatedWithTruth).toBe(16);
    expect(r.abstained).toBe(7);
  });

  it("unprimed config (aai_plain): safety gates + exact snapshot", () => {
    const r = run("aai_plain");
    expect(r.nResolve).toBe(48);
    expect(r.nAbstain).toBe(16);
    expect(r.wrongWine, "zero wrong-wine (incl. truthless ambiguity)").toBe(0);
    expect(r.ooiAbstain, "out-of-inventory pure abstentions").toBe(16);
    expect(r.resolvedCorrect).toBe(11);
    expect(r.disambiguatedWithTruth).toBe(12);
    expect(r.abstained).toBe(25);
  });
});
