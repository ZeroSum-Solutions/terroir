-- Imagery for the X-Wines reference corpus.
--
-- 0131 landed 100,646 real wines and 0130 landed the public bucket their
-- pictures would live in, but nothing ever connected the two. The corpus has
-- no image column at all, so the only bottle photograph anywhere in the
-- product is `wines.hero_image_url` — a per-tenant column with exactly two
-- writers, "a human tapped Add photo" and "a label scan succeeded". A wine
-- that resolves cleanly to the corpus (xwines-profile.ts) can be told what it
-- tastes like and what to eat with it, and still renders as a grey placeholder.
--
-- This is the column that fixes that, plus — and this is the whole point of
-- the shape below — the columns that stop it from lying.
--
-- ── WHY `image_*` AND NOT `label_image_*` ──────────────────────────────────
--
-- There is not, anywhere in the open, a photograph of the actual label of each
-- of 100,646 wines. What exists is three different things of three different
-- strengths, and a single `label_image_url` column would flatten them into one
-- claim that is false for most rows:
--
--   'label'          this wine's own label. X-Wines ships 1,007 of them keyed
--                    by WineID; a product-database entry whose brand AND
--                    product name both clear this repo's measured similarity
--                    floors is the same claim by another route.
--   'producer'       a real photograph of a bottle from THIS producer, a
--                    different cuvée. Right winery, wrong wine. Useful — a
--                    house's bottles share a livery — and NOT this label.
--   'representative' a real photograph of a real wine bottle of the same type
--                    and country, from an unrelated producer. Says nothing
--                    whatsoever about this wine beyond "red, French".
--
-- A reader that cannot tell those apart will print the third as the second and
-- the second as the first. So the kind is stored, not inferred, it is NOT
-- NULL whenever a URL is present, and the column is named for what it holds —
-- an image — rather than for the strongest thing it might be. Every surface
-- that renders one is expected to read `image_kind` and caption accordingly;
-- rendering a 'representative' row without saying so is the bug this column
-- exists to make visible.
--
-- ── PROVENANCE AND LICENSING ──────────────────────────────────────────────
--
-- `image_source` and `image_credit` are stored for every row for the same
-- reason: the imagery does NOT come from one place and does not carry one
-- licence. X-Wines is CC0-1.0 and needs no credit. Open Food Facts product
-- photographs are contributor-uploaded under CC-BY-SA-3.0 and DO. Wikimedia
-- Commons files carry per-file licences that differ file by file. Recording
-- the source and the credit line at ingest is what makes it possible to
-- re-check, re-attribute or drop a source later without re-deriving where
-- every picture came from — see NFR-5 licensing containment.
--
-- Nothing here asserts that a stored image is licensed for any particular use.
-- The columns record what the source said; they are not a clearance.
-------------------------------------------------------------------------------

alter table public.xwines_catalog
  add column image_url    text,
  add column image_kind   text,
  add column image_source text,
  add column image_credit text;

-- The kind vocabulary is closed, and is checked rather than commented, because
-- a typo'd 'representitive' would silently become an unrecognised kind and a
-- caption-less render — which is exactly the failure this design prevents.
alter table public.xwines_catalog
  add constraint xwines_catalog_image_kind_known
    check (image_kind is null or image_kind in ('label', 'producer', 'representative'));

-- A URL with no kind is an unlabelled claim, and a kind with no URL is a
-- dangling one. They travel together or not at all. `image_source` rides with
-- them for the same reason: an image whose origin was not recorded cannot be
-- re-checked or withdrawn. `image_credit` is deliberately NOT in this rule —
-- CC0 material genuinely has no credit line, and forcing one would mean
-- inventing it.
alter table public.xwines_catalog
  add constraint xwines_catalog_image_complete
    check (
      (image_url is null and image_kind is null and image_source is null)
      or (image_url is not null and image_kind is not null and image_source is not null)
    );

-- Partial, on the kind: the queries this serves are "how much of the corpus
-- has a picture, and of what strength" (the coverage report the ingest script
-- prints) and "give me the rows still missing one" (its next run). Both filter
-- on NOT NULL first, so indexing the 100k-row column in full would be paying
-- for the rows neither query ever looks at.
create index xwines_catalog_image_kind_idx
  on public.xwines_catalog (image_kind)
  where image_url is not null;

comment on column public.xwines_catalog.image_url is
  'Public URL of a real photograph associated with this row. Read image_kind '
  'before rendering it: only kind=''label'' is a picture of THIS wine.';

comment on column public.xwines_catalog.image_kind is
  'What image_url actually shows. ''label'' = this wine''s own label. '
  '''producer'' = a bottle from this producer, a different cuvee. '
  '''representative'' = a real bottle of the same type/country from an '
  'unrelated producer, and says nothing about this wine. A surface that '
  'renders a non-''label'' image without captioning it as such is misreporting.';

comment on column public.xwines_catalog.image_source is
  'Where the photograph came from, as a stable token: ''xwines'' (CC0-1.0), '
  '''openfoodfacts'' (contributor photos, CC-BY-SA-3.0), ''wikimedia-commons'' '
  '(per-file licence, carried in image_credit). Recorded so a source can be '
  're-checked or withdrawn without re-deriving provenance.';

comment on column public.xwines_catalog.image_credit is
  'Attribution/licence line the source asked for, verbatim where one exists. '
  'Null means the source states none (CC0), NOT that none is required.';
