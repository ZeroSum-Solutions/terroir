#!/usr/bin/env python3
"""Committed generator for the name-resolver fixtures (provenance + reproducibility).

Regenerates, deterministically:
  voice-eval-inventory.json   from spike 9's fixture_inventory.json
  voice-eval-cases.json       from spike 9's cases.jsonl (resolve + abstain cases only)
  trgm-parity-vectors.json    golden vectors computed by the spike-1 Python
                              trigram implementation composed with the œ/æ
                              pre-fold (matching name-resolver.ts foldAccents)

Source artifacts (spike outputs on this machine — sha256 recorded in the
provenance block of each output):
  ~/projects/terroir-data/spike09-voice-retrieval/{fixture_inventory.json,cases.jsonl}
  ~/projects/terroir-data/spike01-stt/{score.py,utterances.json,results.jsonl}

VALIDATION LINEAGE: score.py's norm/trigrams/similarity was validated
byte-exact (max |delta| = 0.000000, 203 pairs from the actual eval
transcripts) against a live Postgres 16 + pg_trgm instance on 2026-08-25
(throwaway initdb; the raw pg session was not retained — re-validation is a
SPEC-21 acceptance-time task, tracked in the spike-1 write-up). The œ/æ
pre-fold is an app-side extension consistent with
src/domains/identity/normalize.ts and is NOT part of the pg validation.

EVIDENTIARY STATUS: cases + inventory are the resolver rule's TUNING fixture
(the v1→v5 rule was iterated against them); SPEC-21's sealed holdout is the
acceptance set. See name-resolver.eval.test.ts.

DATA LICENSING (flagged by the 2026-08-25 production audit — OWNER DECISION
REQUIRED BEFORE THIS BRANCH IS PUSHED TO THE PUBLIC REMOTE): the inventory
fixture embeds 250 rows derived from the production lwin_catalog (LWIN
identifiers + producer/wine display names, Liv-ex's LWIN standard). LWIN is
published as an open standard, but redistribution terms for catalog rows have
NOT been verified. Options if redistribution is not cleared: regenerate with
synthetic names (weakens eval realism) or keep the fixture out of the public
tree. The STT transcripts are of self-generated TTS audio (no third-party
rights).

Usage:  python3 generate.py          (any python3; stdlib only)
        python3 generate.py --pg     (additionally regenerate pg-oracle.json
                                      against a live Postgres+pg_trgm reached
                                      via psql at $PG_ORACLE_SOCKET:$PG_ORACLE_PORT,
                                      defaults /tmp/zs-pgsock:54329)
"""
import hashlib
import json
import os
import pathlib
import random
import re
import subprocess
import sys
import unicodedata

HERE = pathlib.Path(__file__).parent
SPIKE01 = pathlib.Path.home() / "projects/terroir-data/spike01-stt"
SPIKE09 = pathlib.Path.home() / "projects/terroir-data/spike09-voice-retrieval"
SEED = 20260826


def sha256(p: pathlib.Path) -> str:
    return hashlib.sha256(p.read_bytes()).hexdigest()


# --- the pinned trigram implementation (spike-1 score.py, verbatim) composed
# --- with the œ/æ pre-fold used by name-resolver.ts foldAccents()

def prefold(s: str) -> str:
    return s.replace("œ", "oe").replace("Œ", "Oe").replace("æ", "ae").replace("Æ", "Ae")


def norm(s: str) -> str:
    s = unicodedata.normalize("NFKD", prefold(s))
    s = "".join(c for c in s if not unicodedata.combining(c))
    s = s.lower().replace("'", " ").replace("-", " ")
    s = re.sub(r"[^a-z0-9\s]", " ", s)
    return re.sub(r"\s+", " ", s).strip()


def trigrams(s: str) -> set:
    out = set()
    for w in re.findall(r"[a-z0-9]+", norm(s)):
        p = "  " + w + " "
        out.update(p[i:i + 3] for i in range(len(p) - 2))
    return out


def similarity(a: str, b: str) -> float:
    ta, tb = trigrams(a), trigrams(b)
    if not ta or not tb:
        return 0.0
    return len(ta & tb) / len(ta | tb)


def best_span_similarity(target: str, transcript: str) -> float:
    words = norm(transcript).split()
    n = len(norm(target).split())
    if not words:
        return 0.0
    best = 0.0
    for width in range(1, min(n + 3, len(words) + 1)):
        for i in range(len(words) - width + 1):
            best = max(best, similarity(target, " ".join(words[i:i + width])))
    return best


def main() -> None:
    provenance = {
        "generator": "src/lib/wine-intelligence/fixtures/generate.py",
        "seed": SEED,
        "sources": {
            str(p.relative_to(pathlib.Path.home())): sha256(p)
            for p in [SPIKE09 / "fixture_inventory.json", SPIKE09 / "cases.jsonl",
                      SPIKE01 / "score.py", SPIKE01 / "utterances.json",
                      SPIKE01 / "results.jsonl"]
        },
        "pg_validation": "score.py validated byte-exact vs live Postgres 16 pg_trgm "
                         "(203 pairs, max |delta| 0.000000, 2026-08-25); oe/ae pre-fold "
                         "is an app-side extension outside that validation",
        "status": "TUNING fixture — SPEC-21 sealed holdout is the acceptance set",
    }

    inv = json.load(open(SPIKE09 / "fixture_inventory.json"))
    inv_out = [{"itemId": r["item_id"], "lwinId": r["lwin_id"],
                "displayName": r["display_name"], "producer": r["producer"]} for r in inv]
    (HERE / "voice-eval-inventory.json").write_text(
        json.dumps(inv_out, indent=0, ensure_ascii=False))

    cases = [json.loads(l) for l in open(SPIKE09 / "cases.jsonl")]
    keep = [c for c in cases if c["expected"]["kind"] in ("resolve", "abstain")]
    cases_out = [{"caseId": c["case_id"], "sttConfig": c["stt_config"],
                  "transcript": c["transcript"],
                  "expected": {"kind": c["expected"]["kind"],
                               **({"itemId": c["expected"]["item_id"]} if c["expected"]["kind"] == "resolve" else {}),
                               **({"reason": c["expected"].get("reason")} if c["expected"]["kind"] == "abstain" else {})}}
                 for c in keep]
    (HERE / "voice-eval-cases.json").write_text(
        json.dumps(cases_out, indent=0, ensure_ascii=False))

    utts = json.loads((SPIKE01 / "utterances.json").read_text())
    targets = sorted({t for u in utts for t in u["targets"]})
    results = [json.loads(l) for l in open(SPIKE01 / "results.jsonl") if l.strip()]
    rng = random.Random(SEED)

    sim_vectors = []

    def add(a, b):
        sim_vectors.append({"a": a, "b": b, "sim": similarity(a, b)})

    for t in targets:
        add(t, t)
        add(t, rng.choice(targets))
    for a, b in [("côte-rôtie", "cote rotie"), ("Château Rayas", "chateau rayas"),
                 ("Bâtard-Montrachet", "batard montrachet"), ("Ridge Monte Bello", "ridge monte bello"),
                 ("Peñafiel", "penafiel"), ("Grüner Veltliner", "gruner veltliner"),
                 ("d'Yquem", "dyquem"), ("d'Yquem", "d yquem"), ("", "anything"),
                 ("Romanée-Conti", "romanee conti 2016"), ("Läfite", "lafite"),
                 ("DRC La Tâche", "la tache"), ("weird ß char", "weird char"),
                 ("l'Église-Clinet", "l eglise clinet"),
                 ("cœur", "coeur"), ("Clos de la Cœur", "clos de la coeur"),
                 ("Æther Ævum", "aether aevum"), ("œ", "oe")]:
        add(a, b)

    span_vectors = []
    sample = rng.sample([r for r in results if r.get("transcript")], 120)
    for r in sample:
        t = rng.choice(r["targets"])
        span_vectors.append({"target": t, "transcript": r["transcript"],
                             "best": best_span_similarity(t, r["transcript"])})

    (HERE / "trgm-parity-vectors.json").write_text(json.dumps(
        {"provenance": provenance, "sim": sim_vectors, "bestSpan": span_vectors},
        indent=0, ensure_ascii=False))
    print(f"inventory {len(inv_out)} · cases {len(cases_out)} · "
          f"sim vectors {len(sim_vectors)} · span vectors {len(span_vectors)}")

    if "--pg" in sys.argv:
        generate_pg_oracle(sim_vectors)


def generate_pg_oracle(sim_vectors) -> None:
    """Regenerate pg-oracle.json: live pg_trgm similarity() over the NORMALIZED
    form of every sim vector pair. Committed so the Postgres side of the parity
    claim is a reproducible artifact, not a session anecdote. The generator
    asserts |python - pg| < 1e-6 per pair (pg similarity returns float4) and
    refuses to write on any violation."""
    sock = os.environ.get("PG_ORACLE_SOCKET", "/tmp/zs-pgsock")
    port = os.environ.get("PG_ORACLE_PORT", "54329")
    pairs = []
    for v in sim_vectors:
        a, b = norm(v["a"]), norm(v["b"])
        pairs.append((a, b, v["sim"]))
    values = ",".join(f"('{a}','{b}')" for a, b, _ in pairs)  # norm'd strings are ['a-z0-9 ']-safe
    sql = f"SELECT similarity(a,b)::float8 FROM (VALUES {values}) AS t(a,b);"
    out = subprocess.run(
        ["psql", "-h", sock, "-p", port, "-d", "postgres", "-At", "-c", sql],
        capture_output=True, text=True, check=True).stdout.split()
    assert len(out) == len(pairs), f"pg returned {len(out)} rows for {len(pairs)} pairs"
    version = subprocess.run(
        ["psql", "-h", sock, "-p", port, "-d", "postgres", "-At",
         "-c", "select current_setting('server_version')"],
        capture_output=True, text=True, check=True).stdout.strip()
    rows = []
    worst = 0.0
    for (a, b, py), pg_s in zip(pairs, out):
        pg_val = float(pg_s)
        worst = max(worst, abs(py - pg_val))
        assert abs(py - pg_val) < 1e-6, f"python/pg divergence on ({a!r},{b!r}): {py} vs {pg_val}"
        rows.append({"a": a, "b": b, "pg": pg_val})
    (HERE / "pg-oracle.json").write_text(json.dumps(
        {"provenance": {"postgres_version": version, "extension": "pg_trgm",
                        "query": "similarity(a,b)::float8 over the norm()-folded pair",
                        "tolerance_vs_python": "1e-6 (pg similarity is float4)",
                        "generator": "generate.py --pg"},
         "pairs": rows}, indent=0, ensure_ascii=False))
    print(f"pg-oracle: {len(rows)} pairs vs Postgres {version}, worst |delta| {worst:.2e}")


if __name__ == "__main__":
    sys.exit(main())
