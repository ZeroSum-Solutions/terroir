-- down for 0101_wine_identity_backfill.sql
-- 0101 adds no schema — only data (canonical_wines/wine_variants rows and
-- wines.wine_variant_id/canonical_wine_id values) into tables 0097/0098
-- define. Rolling back 0098 and 0097 removes that data along with the
-- columns/tables it lives in; there is nothing schema-level for this file
-- to revert on its own.
begin;

commit;
