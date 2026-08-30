-- Revoke the column-level SELECT that 0141 added, returning canonical_wines'
-- grant to the twelve columns 0097 enumerated.
--
-- REVOKE here is the correct inverse and not a wider hammer: the grant being
-- undone was itself column-level, so this removes exactly those two columns
-- and leaves the 0097 list untouched. Rolling this back re-breaks
-- resolveXWinesProfile's trusted-link read (42501) by design — that is what
-- reverting 0141 means.
revoke select (xwines_wine_id, xwines_match_score)
  on table public.canonical_wines from authenticated;
