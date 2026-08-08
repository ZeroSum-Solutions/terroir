-- Reverse the TER-026 atomic metadata entry point. The owner/manager wine
-- UPDATE policy and hardened enrichment RPC are security corrections and are
-- intentionally retained: the pre-0081 application path remains compatible
-- for managers without reopening the staff data-API bypass.

drop function if exists public.update_wine_metadata_atomic(uuid, uuid, jsonb);
