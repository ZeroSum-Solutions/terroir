-- Down migration for 0049_wines_colour
-- Restore enrich_wines_batch to 0048 version (without colour)

undefined
ALTER TABLE public.wines DROP COLUMN colour;
