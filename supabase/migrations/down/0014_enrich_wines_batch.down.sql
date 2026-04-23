-- Reverse of 0014_enrich_wines_batch.sql

drop function if exists public.enrich_wines_batch(jsonb, uuid);
