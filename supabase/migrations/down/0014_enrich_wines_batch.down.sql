-- Reverse of 0014_enrich_wines_batch.sql
--
-- C29 (db audit 2026-08-23): this file dropped enrich_wines_batch(jsonb, uuid)
-- — the forward migration creates (uuid, jsonb). DROP FUNCTION IF EXISTS
-- against a nonexistent overload is a silent, exit-0 no-op, so this "rollback"
-- reported success while leaving the real function untouched. Argument order
-- corrected to match 0014's own signature exactly (and its own header
-- comment, which already documented the correct order).

drop function if exists public.enrich_wines_batch(uuid, jsonb);
