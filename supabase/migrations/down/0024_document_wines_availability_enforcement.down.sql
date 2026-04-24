-- Down for 0024_document_wines_availability_enforcement.sql (DEBT-023).
-- Clears the column comments set by 0024. Does not restore a
-- pre-0024 default because none of the three columns had a comment
-- before 0024 (verified against live DB).

comment on column public.wines.is_eightysixed is null;
comment on column public.wines.eightysixed_at is null;
comment on column public.wines.eightysixed_by is null;
