-- 0102_import_sessions.sql
--
-- P3 (2026-08-23-p3-chunked-import.md, §3.1) — a new table grouping N
-- import_batches rows into one logical multi-chunk onboarding. Devin's
-- decision this piece is built on: chunked ingest at 4,000-5,000 rows per
-- chunk (MAX_ROWS stays 5000, src/domains/import/constants.ts) rather than
-- raising the row cap or deploying the undeployed Railway worker. A
-- partner's ~20,050-row file ships as 4-5 chunk uploads; import_sessions is
-- what lets the app treat those as one onboarding for progress, resume, and
-- revert-as-a-unit, instead of five unrelated batches.
--
-- status is a convenience projection recomputed after every child batch's
-- state change (same posture as import_batches.status, 0076) — not an
-- independent source of truth.
--
-- RLS: identical shape to import_batches (0076) — select/insert/update via
-- is_member/is_member_with_role(restaurant_id, 'staff'), no delete policy
-- (permanent audit trail, same posture as import_batches itself).
--
-- DOWN: plain DROP TABLE — no destructive row surgery needed, no other
-- table's data depends on this one existing (import_batches.session_id is
-- added by 0103, nullable, ON DELETE SET NULL there).

create table public.import_sessions (
  id                  uuid        primary key default gen_random_uuid(),
  restaurant_id       uuid        not null references public.restaurants(id) on delete cascade,
  created_by          uuid        references auth.users(id) on delete set null,
  label               text,
  source_sha256       text,
  declared_chunk_total integer    check (declared_chunk_total is null or declared_chunk_total > 0),
  status              text        not null default 'in_progress' check (
    status in ('in_progress', 'completed', 'reverted')
  ),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

comment on table public.import_sessions is
  'One row per multi-chunk CSV cellar onboarding (P3, 2026-08-23-p3-chunked-'
  'import.md §3.1) — groups the N import_batches rows one 4,000-5,000-row '
  'chunk split produces. status is a convenience projection recomputed '
  'after every child batch state change, not an independent source of '
  'truth. source_sha256/declared_chunk_total are nullable: a session can '
  'exist without them if the operator''s upload tooling does not supply a '
  'manifest yet, degrading to "no cross-chunk source-consistency check," '
  'never a hard failure.';

comment on column public.import_sessions.source_sha256 is
  'sha256 of the pre-split ORIGINAL file''s raw bytes (the same value every '
  'chunk''s manifest reports as source_csv_sha256) — used to reject a chunk '
  'from a different source file being mixed into this session. Nullable: '
  'degrades to no cross-chunk check, never a hard failure.';

comment on column public.import_sessions.declared_chunk_total is
  'Operator/manifest-supplied expected chunk count — informational for the '
  'progress UI only, never a hard gate. A 6th corrective chunk must still '
  'be addable even when this says 5.';

create index import_sessions_restaurant_idx
  on public.import_sessions (restaurant_id, created_at desc);

create trigger import_sessions_set_updated_at
  before update on public.import_sessions
  for each row execute function public.set_updated_at();

alter table public.import_sessions enable row level security;

create policy "members can read import sessions"
  on public.import_sessions for select
  using (public.is_member(restaurant_id));

create policy "members can create own import sessions"
  on public.import_sessions for insert
  with check (
    public.is_member_with_role(restaurant_id, 'staff')
    and created_by = auth.uid()
  );

-- Needed for the session-status recompute after each child batch's
-- apply/resolve/revert, and for revert_import_session's own status
-- transition. No delete policy — a session is never removed, only
-- reverted (status transition, audit trail preserved) — same posture as
-- import_batches (0076).
create policy "members can update own import sessions"
  on public.import_sessions for update
  using      (public.is_member_with_role(restaurant_id, 'staff'))
  with check (public.is_member_with_role(restaurant_id, 'staff'));

-- Same reasoning as 0076's import_batches grant comment: a brand new table
-- starts with NO base table privilege for `authenticated` at all (RLS
-- policies alone are not enough; Postgres checks the base GRANT first).
grant select, insert, update on table public.import_sessions to authenticated;
revoke delete on table public.import_sessions from authenticated;
