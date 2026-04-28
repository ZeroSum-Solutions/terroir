-- Down for 0027_invitations_email_required.sql (BND-011).
--
-- Reverts the NOT NULL constraint on public.invitations.email. Existing
-- populated emails remain populated; this just allows future inserts to
-- pass NULL again. Combine with reverting the application-side changes
-- (invite POST email-required, accept POST email-match guard) to fully
-- roll back BND-011 behaviour.

ALTER TABLE public.invitations
  ALTER COLUMN email DROP NOT NULL;
