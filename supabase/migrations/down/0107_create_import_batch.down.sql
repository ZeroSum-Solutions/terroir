-- Reverse of 0107_create_import_batch.sql
--
-- DB-only reversal (see 0106's down for the same note): drops the
-- function. confirmImportBatch (batch-service.ts) calling this RPC would
-- fail with 42883 (undefined_function) afterward — the observable proof
-- this down ran — and would need reverting to its own pre-P3 two-.insert()
-- -calls body (application code, out of a migration's scope) to function
-- again.

drop function if exists public.create_import_batch(uuid, uuid, text, integer, jsonb, uuid, integer, integer, text, text);
drop index if exists public.import_batch_rows_dedup_key_idx;
