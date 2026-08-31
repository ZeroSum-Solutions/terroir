-- Reverses 0144: removes the fuzzy wine-search RPC, its trigram index and the
-- immutable unaccent wrapper.
--
-- Rolling this back re-breaks SCAN-06 — a misspelled or accent-dropped query
-- ("Fredric savart") returns nothing again.
--
-- It does NOT require a matching code revert, and that is deliberate.
-- src/app/api/wines/search/route.ts calls search_wines_fuzzy only as a
-- fallback behind the exact substring pass, and treats an RPC failure as an
-- unavailable enhancement: it reports the error to Sentry and returns the
-- exact result, which is precisely the answer the route gave before SCAN-06.
-- So a database rolled back ahead of (or deployed behind) the code degrades to
-- "no fuzzy results", never to a 500. Reverting the route as well is optional
-- tidying, not a correctness requirement.
--
-- Order matters: the index expression calls immutable_unaccent(), so the index
-- goes before the function it depends on.

drop function if exists public.search_wines_fuzzy(uuid, text, float, integer);

drop index if exists public.wines_search_text_trgm_idx;

drop function if exists public.immutable_unaccent(text);

-- pg_trgm and unaccent are NOT dropped. Both predate 0144 (0097/0101 and the
-- 0003 wine-intelligence catalogues create and depend on them); 0144's
-- `create extension if not exists` was a no-op assertion, not an install.
