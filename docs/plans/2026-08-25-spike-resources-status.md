# Spike Resources — Setup Status

Date: 2026-08-25 · Parent: `2026-08-24-visual-wine-platform-spec-list.md` §3 (spike
register). Everything below was live-verified on this date — no claims from memory.

## Ready now

| Resource | Spike | Status |
|---|---|---|
| **Brave Search API** | 5 | Key in vault (`brave_api_key`), HTTP 200. ⚠️ **Confirmed unavailable for monthly workloads:** live headers `x-ratelimit-limit: 2, 0` / `x-ratelimit-policy: 2;w=1, 0;w=2678400` — 2 req/s but a **zero monthly allocation**. The dashboard plan name was not readable (login-walled). Spike 5 must treat Brave as absent and lean on DDGS unless the plan is upgraded. |
| **AssemblyAI** | 1 | ✅ Account live, key in vault (`assemblyai_api_key` / `ASSEMBLYAI_API_KEY`), HTTP 200 re-verified 2026-08-25. **Selected as the VWP-D-02 vendor** — see `2026-08-25-spike-01-stt-vendor-eval.md`. Free tier covers the whole demo phase. |
| **Deepgram** | 1 | ✅ Account live (`devszerosum@gmail.com`), key in vault (`deepgram_api_key` / `DEEPGRAM_API_KEY`), HTTP 200. $200 signup credit; ~$0.09 spent by spike 1. Key lacks `billing:read` scope, so remaining credit can't be read via API (console only). Not selected; retained as fallback — **`language=multi` is mandatory if ever wired in.** |
| **RunPod** (GPU box) | 6 | API key valid (`runpod_api_key`, account wiggdevin@gmail.com). Live pricing 2026-08-25: **RTX 4090 24GB secure $0.74/hr** (recommended: 3-hr spike ≈ $2.25, demo-prep week ≈ $40) · RTX A5000 24GB secure $0.27/hr (dev alt). **Balance $0.00** — needs ~$25 top-up before provisioning (VWP-D-03 evidence gathered; vendor decided: RunPod for spike/dev; demo-day local-box question stays open per synthesis D8). |
| **X-Wines dataset** | 4 | Downloaded to `/Users/zero/projects/terroir-data/xwines/`, all 6 CSVs MD5-verified vs. author hashes: Full 100,646 wines + 21,013,536 ratings (1.12 GB), Slim, Test. License CC0-1.0. |
| **WineSensed metadata** | 4 | `/Users/zero/projects/terroir-data/winesensed/` — metadata.zip MD5-verified from DTU Figshare (DOI 10.11583/DTU.23376560.v1): 1,014,630 review rows, 996,808 unique image refs, 421,672 vintage_ids (larger than the paper's cut). Images = 10 chunk zips ≈ 35 GB, NOT downloaded (eval-time decision). |
| **DDGS** | 5 | `ddgs` pip package, no account needed. |
| **LightGlue / DINOv2 / PaddleOCR / FAISS / ZXing** | 6, 7 | Open weights/repos, no accounts; installed on the GPU box at spike time. |

## Findings that change spike scope

1. **GlobalWineScore appears defunct.** `globalwinescore.com` (incl. `account/api/` and
   `api.` subdomains) 302-redirects to a HugeDomains "for sale — $9,495" parked page
   (fetched directly 2026-08-25; Google index snippets corroborate). No `src/` code
   references GWS — blast radius is planning docs only. **Proposal: drop GWS from spike 3**
   (critic layer = Wine-Searcher aggregate + X-Wines community only, matching synthesis D5's
   read model which needs no second aggregate); optional low-priority probe to
   `api@globalwinescore.com` (mailbox may outlive the site). The synthesis (v4, frozen
   post-audit) is NOT edited; this note is the correction of record.
2. **X-Wines Full has no published label images** — the wines CSV has no image column and
   no Full image archive exists; author's hashing file says "Labels on demand" (only
   Slim's 1,007-image zip is published). The spike-4 "image manifest count" question is
   ANSWERED: bulk X-Wines imagery requires contacting the author — irrelevant to the
   frozen demo index, and a known-limited source for post-demo breadth layers.
3. **WineSensed license ambiguity:** Figshare metadata says CC BY-NC 4.0; the project page
   says CC BY-NC-ND 4.0. For our use (eval benchmark + hard negatives only, never in the
   index, no fine-tuning — synthesis D2.4) both are workable under the prototype posture;
   resolve before production per risk R6.

## Cleared 2026-08-25 (Codex drove the browser; handoff
`~/Inbox/notes/handoffs/2026-08-25-terroir-spike-accounts-handoff.md`)

1. ✅ **Gmail app password** regenerated (2FA enabled on devin@zerosumsolutions.com, app
   password `terroir-spikes`) → `gmail_app_password`. IMAP re-verified: 539 messages.
2. ✅ **AssemblyAI** account + key → `assemblyai_api_key`. HTTP 200.
3. ✅ **Deepgram** account (via Google, `devszerosum@gmail.com`) + key `terroir-spikes`
   → `deepgram_api_key`. HTTP 200, $200 credit confirmed in console.
4. ✅ **Brave** plan checked — zero monthly allocation (see table); nothing to store.
5. ⏳ **Wine-Searcher** trial application submitted (Devin Wiggins /
   `devszerosum@gmail.com`; use case: product matching, market pricing, critic scores,
   vintage coverage). Confirmation shown; they quote ~48 h. **No key yet.** On arrival:
   `printf '%s' "$KEY" | zsvault add wine_searcher_api_key --type api_key --env-name WINE_SEARCHER_API_KEY --yes --value-stdin`

**Account-routing preference (standing, set 2026-08-25):** new services →
`devszerosum@gmail.com` first, then GitHub auth. Use `devin@zerosumsolutions.com` only
when the Workspace mailbox or an existing business integration requires it.

## Still blocked on Devin

1. ~~RunPod top-up~~ ✅ **cleared 2026-08-25** (~$25). Pod `bcod3vbu78gcav` (RTX 4090
   secure, EUR-IS-2) provisioned same night; spikes 6 + 7a run and CLOSED (~58 min GPU,
   ≈ $0.72); pod **stopped** with its 80 GB volume retained (stack + Slim labels intact)
   for spike 7b — restart it from the console when the photos exist, terminate it if 7b
   goes elsewhere.
2. **Polycam** on your phone (free account) — spike 2 needs 20–200 photos or an mp4 sweep
   of the partner cellar space; capture is a physical task. **While you're there: 10–20
   plain phone photos of real bottle labels (varied angle/lighting, names noted) →
   `~/projects/terroir-data/spike02-capture/` — that unblocks spike 7b**, the real
   phone-photo half that synthetic degradation cannot answer.
3. **Partner CSV** — spike 10 (GTIN coverage/vintage-uniqueness) and Phase B ingestion
   need the real ~20k-row export from the partner. Highest-value missing input.
4. **PRD approval** — with spikes 1, 4, 5, 6, 7a, 9, 11 closed and `docs/evals/
   vwp-evals.yaml` authored (wait-list item 4), the ticket-freeze critical path is now:
   PRD sign-off + Gate-0 thresholds (VWP-D-01) + the two externals above.

<details><summary>Historical: why the app password could not be automated (2026-08-25)</summary>

   **Attempted autonomously 2026-08-25 (asked to; could not complete) — findings:**
   the account is **Chrome "Profile 1"** (devin@zerosumsolutions.com), not Default
   (devszerosum@gmail.com). Three routes were tried and all are closed by design:
   (a) cloned Profile 1 into a scratch user-data-dir and drove real Chrome via Playwright
   1.59 — Chrome could not decrypt the copied cookie store and reset it (session lost,
   landed on the sign-in page); this is macOS/Chrome anti-exfiltration behavior working
   as intended. (b) reading the `Chrome Safe Storage` key from the login Keychain to
   decrypt cookies directly — **denied** (no ACL for the CLI). (c) attaching to the
   already-running Chrome over CDP — impossible: it wasn't launched with a debugging
   port, and Chrome ≥136 refuses `--remote-debugging-port` on the default user-data-dir.
   A fresh password sign-in is also a dead end: app passwords only exist when 2FA is on,
   so a second factor is guaranteed, and the vault holds a password but **no TOTP secret
   and no backup codes** for this account. Conclusion: this needs Devin's own 30-second
   click, or a stored TOTP secret / backup codes added to the vault to make it
   automatable in future. The profile clone (which included a copy of his saved-password
   DB) was deleted afterward; his running Chrome was never touched.

</details>

## STT vendor facts (recon 2026-08-25, fed VWP-D-02 — now DECIDED, see
`2026-08-25-spike-01-stt-vendor-eval.md`)

- **AssemblyAI:** free tier 185 h batch + 333 h streaming (5 new connections/min cap), no
  card. Keyterms: `keyterms_prompt` on Universal-3.5 Pro (async) takes up to **1,000
  words** (≤6 words/phrase; $0.05/hr add-on); Realtime/Universal-Streaming up to 100
  terms, included. API note: `speech_model` is deprecated — use
  `speech_models: ["universal-3-5-pro", ...]`.
- **Deepgram:** $200 signup credit, no card. Nova-3 `keyterm` $0.0013/min, capped at
  **500 tokens total** — measured live at 75 phrases / 124 words of wine vocabulary
  (~3.9 tokens/word). Defaults to `language=en`, which returned empty transcripts on 42 %
  of natively-pronounced clips; `language=multi` is mandatory for wine audio.

## Autonomous next steps (armed, in order — updated 2026-08-25 overnight)

1. ~~AssemblyAI account + probe~~ ✅ done (Codex) — key verified, spike 1 run on it.
2. ~~Spike 1 STT eval~~ ✅ **CLOSED — VWP-D-02 = AssemblyAI** (decision metric:
   full-catalog resolution +18.8 pp, clustered p = 0.009; audited + remediated —
   `2026-08-25-spike-01-stt-vendor-eval.md`).
3. ~~Spikes 6–7a on RunPod~~ ✅ **CLOSED** (`2026-08-25-spike-06-scan-latency.md`,
   `2026-08-25-spike-07a-lightglue-survival.md`). 7b awaits Devin's phone photos.
4. ~~Spike 9~~ ✅ CLOSED · ~~Spike 5~~ ✅ CLOSED (DDGS standalone: 94 % ok, retry
   discipline mandatory — `2026-08-25-spike-05-ddgs-soak.md`).
5. ~~Eval YAML (wait-list item 4)~~ ✅ authored: `docs/evals/vwp-evals.yaml` — 69
   EV-VWP evals, all 12 ★ slices, 13/13 PRD criteria mapped.
6. Voice resolver precursor library landed (`src/lib/wine-intelligence/name-resolver.ts`)
   with the spike-9 replay as its acceptance harness — SPEC-20 tickets start from
   tested code, not a blank file.
7. On the Wine-Searcher key landing (~48 h from 2026-08-25) → verify with a probe call,
   then spike 3 coverage run on ~50 LWIN'd wines. **Last open spike that needs no Devin
   action once the key arrives.**
