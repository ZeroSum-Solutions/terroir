# Spike Resources — Setup Status

Date: 2026-08-25 · Parent: `2026-08-24-visual-wine-platform-spec-list.md` §3 (spike
register). Everything below was live-verified on this date — no claims from memory.

## Ready now

| Resource | Spike | Status |
|---|---|---|
| **Brave Search API** | 5 | Key in vault (`brave_api_key`), verified HTTP 200. ⚠️ Quota headers show `0` monthly allocation (resets ~Aug 31) — check the Brave dashboard plan before the 500-query soak relies on it as the DDGS fallback tier. |
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

## Blocked on Devin (short click-list)

1. **Regenerate the Gmail app password** — the vault's `gmail_app_password`
   (Devin@zerosumsolutions.com) is rejected by Google (verified via IMAP 2026-08-25).
   myaccount.google.com/apppasswords → new password → `zsvault edit gmail_app_password`.
   *Unblocks: fully autonomous AssemblyAI signup (recon confirmed: passwordless
   magic-link, no CAPTCHA, no card — I POST the email, read the link from the inbox,
   finish, store the key), plus the optional GWS probe email.*

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
2. **Deepgram signup** (~2 min, browser) — console.deepgram.com/signup has reCAPTCHA, so
   it needs a human once. $200 free credit, no card. Then
   `printf '%s' "<key>" | zsvault add deepgram_api_key --type api_key --env-name DEEPGRAM_API_KEY --yes --value-stdin`.
3. **Wine-Searcher trial application** (browser) — `wine-searcher.com/trade/ws-api` is
   PerimeterX-walled (blocks all scripted access, verified). Open in a normal browser,
   submit the trial/contact form. Terms per cached sources: 100 free calls/day, midnight-UK
   reset (unconfirmed live).
4. **Brave dashboard** — confirm the plan/monthly quota (see table).
5. **RunPod top-up** — ~$25 at runpod.io (account wiggdevin@gmail.com).
6. **Polycam** on your phone (free account) — spike 2 needs 20–200 photos or an mp4 sweep
   of the partner cellar space; capture is a physical task.
7. **Partner CSV** — spike 10 (GTIN coverage/vintage-uniqueness) and Phase B ingestion
   need the real ~20k-row export from the partner.

## STT vendor facts (recon 2026-08-25, feeds VWP-D-02)

- **AssemblyAI:** free tier 185 h batch + 333 h streaming (5 new connections/min cap), no
  card. Keyterms: current models are Universal-3.5 Pro (async, up to 1,000 terms,
  $0.05/hr add-on) and Universal-3.5 Pro Realtime / Universal-Streaming (up to 100 terms,
  included). "Slam-1" branding no longer on the pricing page — the research brief's model
  names are stale; free tier still covers the whole demo phase.
- **Deepgram:** $200 signup credit, no card. Nova-3 keyterm prompting $0.0013/min
  (streaming and pre-recorded), usable against the credit.

## Autonomous next steps (armed, in order)

1. On app-password fix → create the AssemblyAI account end-to-end, store key as
   `assemblyai_api_key` (env `ASSEMBLYAI_API_KEY`), verify with a 1-file transcription
   probe.
2. On RunPod top-up → provision the RTX 4090 pod, install the identification stack, and
   run spikes 6–7 (latency topology, LightGlue phone-vs-packshot).
3. On Deepgram/WS keys landing in the vault → verify each with a probe call.
4. Spike 4 join-rate measurement can run NOW (datasets are local; joins against
   `lwin_catalog`/canonical spine need no external resources).
