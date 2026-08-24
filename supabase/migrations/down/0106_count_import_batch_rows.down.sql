-- Reverse of 0106_count_import_batch_rows.sql
--
-- Drops the function. This is a DB-only reversal, same as every other down
-- migration in this set: it does not and cannot revert the TypeScript
-- caller (batch-service.ts calls this RPC by name after the P3 changes)
-- back to the old uncapped `.select()` — that's application code, outside
-- a migration's scope. Proof this down actually ran: calling
-- count_import_batch_rows afterward fails with 42883 (undefined_function),
-- not with a result — the observable, verifiable signal the function is
-- gone, which is what a DB down migration can prove.

drop function if exists public.count_import_batch_rows(uuid);
