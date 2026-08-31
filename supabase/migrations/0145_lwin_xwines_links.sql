-- 0145_lwin_xwines_links.sql
-- WS-IDENT P0 — storage for the LWIN ↔ X-Wines batch linkage
-- (docs/plans/2026-08-31-ws-ident-identity-policy.md §2–§3, §5).
--
-- WHERE the corpus-level link lives is the decision here. 0132 put the
-- SERVING link on canonical_wines.xwines_wine_id, which is right for tenant
-- wines but cannot carry the linkage program: canonical_wines has ~1.4k rows
-- while the linkage runs over lwin_catalog's 211k, and §5 requires every
-- accepted link to record run id, score vector and rule version, plus
-- tombstones for pairs a human has split — none of which belongs as columns
-- on the identity spine. So the batch writes HERE, at the corpus grain
-- (lwin_id → xwines_wine_id), and canonical_wines rows that carry an lwin7
-- inherit their xwines_wine_id from an accepted row of this table. P1's
-- palette reads this table to dedupe the two corpora ("honest dedupe only
-- where P0 linked" — plan §7).
--
-- One row per LWIN entry, not per run: the committed coverage reports
-- (docs/plans/ws-ident-runs/) are the per-run history; this table answers
-- "what is the current decision for this row and which run made it".
-- Abstention is a stored, visible outcome (status = 'abstained'), never the
-- absence of a row for a processed entry — §3 makes it a first-class result.

create table public.xwines_link_runs (
  id            uuid        primary key default gen_random_uuid(),
  started_at    timestamptz not null default now(),
  finished_at   timestamptz,
  -- LINKAGE_RULE_VERSION from src/lib/wine-intelligence/xwines-linkage.ts:
  -- derived there from the live floors/gap/margin so it cannot drift from
  -- what actually ran.
  rule_version  text        not null,
  params        jsonb       not null,
  notes         text
);

comment on table public.xwines_link_runs is
  'One row per WS-IDENT linkage batch run: the rule version and parameters '
  'every link row of that run was decided under (identity policy §5). '
  'Operator/batch plumbing — not readable by application sessions.';

create table public.lwin_xwines_links (
  lwin_id        text        primary key references public.lwin_catalog (lwin_id) on delete cascade,
  -- Null except where a candidate is recorded (accepted always; review when
  -- one was identified). Cascade, not set-null: a corpus row deleted from
  -- xwines_catalog would leave a link asserting a wine that no longer exists,
  -- and the CHECKs below refuse the shapes set-null would produce.
  xwines_wine_id integer     references public.xwines_catalog (wine_id) on delete cascade,
  status         text        not null check (status in ('accepted', 'review', 'abstained')),
  -- 'exact' = seed-pass equality on identity-normalized (producer, cuvée);
  -- 'trigram' = match_xwines scoring under the xwines-profile.ts floors.
  method         text        check (method in ('exact', 'trigram')),
  score          real,
  producer_score real,
  name_score     real,
  -- Blended score of the nearest OTHER candidate, kept so the §3 ambiguity
  -- guard's margin is re-examinable without re-running the matcher.
  second_score   real,
  review_reason  text        check (review_reason in ('ambiguous', 'near-floor', 'tombstoned', 'name-mismatch')),
  run_id         uuid        not null references public.xwines_link_runs (id),
  updated_at     timestamptz not null default now(),
  -- §5: an accepted link must name its corpus row and its measurement. An
  -- exact-join acceptance carries no similarity vector — normalized equality
  -- WAS the measurement — but a trigram acceptance without its scores would
  -- be a claim with the evidence discarded.
  constraint lwin_xwines_links_accepted_shape check (
    status <> 'accepted'
    or (
      xwines_wine_id is not null
      and method is not null
      and (
        method = 'exact'
        or (score is not null and producer_score is not null and name_score is not null)
      )
    )
  ),
  -- Abstention means "no link"; a corpus id on an abstained row would assert
  -- the very match the batch declined to make.
  constraint lwin_xwines_links_abstained_shape check (
    status <> 'abstained' or xwines_wine_id is null
  ),
  -- A review row must say why it queued; a reason anywhere else is noise
  -- wearing the costume of a decision.
  constraint lwin_xwines_links_review_reason check (
    (status = 'review') = (review_reason is not null)
  )
);

comment on table public.lwin_xwines_links is
  'Current WS-IDENT linkage decision per lwin_catalog row (identity policy '
  '§3): accepted links carry their corpus id + score vector, review rows '
  'their reason, abstentions stand as first-class visible outcomes. Written '
  'only by the batch (service_role); authenticated sessions read it so P1 '
  'search can dedupe the two corpora where a link was accepted.';

-- Reverse lookup for dedupe ("is this corpus row already claimed?"). Partial:
-- most of the 211k rows will abstain — the corpus is consumer-review breadth,
-- LWIN is trade breadth — and indexing those nulls would be most of the index.
create index lwin_xwines_links_xwines_wine_id_idx
  on public.lwin_xwines_links (xwines_wine_id)
  where xwines_wine_id is not null;

-- The review queue scan.
create index lwin_xwines_links_review_idx
  on public.lwin_xwines_links (status)
  where status = 'review';

create trigger lwin_xwines_links_set_updated_at
  before update on public.lwin_xwines_links
  for each row execute function public.set_updated_at();

-- §5 false-merge recovery: a split tombstones the pair, and a tombstoned pair
-- is never auto-accepted again — review only. Keyed by the pair, not the
-- lwin_id, so splitting one bad match does not stop a DIFFERENT corpus row
-- from linking later.
create table public.lwin_xwines_link_tombstones (
  lwin_id        text        not null references public.lwin_catalog (lwin_id) on delete cascade,
  xwines_wine_id integer     not null references public.xwines_catalog (wine_id) on delete cascade,
  reason         text        not null,
  created_at     timestamptz not null default now(),
  primary key (lwin_id, xwines_wine_id)
);

comment on table public.lwin_xwines_link_tombstones is
  'Pairs a human split after a false merge (identity policy §5). The batch '
  'must never auto-accept a tombstoned pair, and any tombstone among a row''s '
  'candidates routes the row to review. Operator/batch plumbing — not '
  'readable by application sessions.';

-- ── Privileges ─────────────────────────────────────────────────────────────
-- Supabase's default privileges grant CRUD on new public tables to anon and
-- authenticated (0137's precedent and reasoning). The intended contract is
-- asymmetric: links are global reference data (authenticated select-only, the
-- shape of lwin_catalog); runs and tombstones are operator/batch plumbing
-- denied at the privilege layer, with RLS-on-no-policy as the backstop —
-- exactly producer_backfill_audit's two-layer deny.

alter table public.xwines_link_runs enable row level security;
alter table public.lwin_xwines_links enable row level security;
alter table public.lwin_xwines_link_tombstones enable row level security;

revoke all on public.xwines_link_runs from anon, authenticated;
revoke all on public.lwin_xwines_links from anon, authenticated;
revoke all on public.lwin_xwines_link_tombstones from anon, authenticated;

grant select on public.lwin_xwines_links to authenticated;

create policy "anyone authenticated can read lwin_xwines_links"
  on public.lwin_xwines_links for select to authenticated
  using (true);

grant select, insert, update, delete on public.xwines_link_runs to service_role;
grant select, insert, update, delete on public.lwin_xwines_links to service_role;
grant select, insert, update, delete on public.lwin_xwines_link_tombstones to service_role;

-- The batch's trigram pass calls match_xwines as service_role. 0132/0134
-- revoked the function from PUBLIC and granted only authenticated — correct
-- for the read-time path, but service_role holds no implicit function
-- privileges once PUBLIC is revoked, so the batch was denied outright
-- (measured live before this grant: "permission denied for function
-- match_xwines" on every scored row).
grant execute on function public.match_xwines(text, text, float, integer) to service_role;
