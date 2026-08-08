-- Reverse TER-026 atomic wine metadata writes. Existing manual_overrides data
-- remains valid and continues to protect enrichment through the 0049 RPC.

drop function if exists public.update_wine_metadata_atomic(uuid, uuid, jsonb);
