-- 0149_seed_descriptors.sql
--
-- The starting controlled vocabulary for house tasting notes, per Task 4 of
-- docs/superpowers/plans/2026-09-03-wine-page.md.
--
-- THIS LIST IS A STARTING POINT, NOT A FINISHED ONE. §8 of the design spec
-- records it as an open item for the owner: a vocabulary that does not match
-- how this house actually talks about wine gets ignored, and an ignored
-- vocabulary produces an empty aggregate — which is the one outcome the whole
-- feature cannot survive. Adding to it later is an ordinary migration; the
-- slugs below are stable identifiers and must not be renamed once notes
-- reference them.
--
-- `on conflict do nothing` makes this idempotent, which matters because it is
-- re-run on every local `supabase db reset` and because the owner's pass will
-- land as a second insert rather than a rewrite of this one.
--
-- FAMILIES CARRY NO COLOUR. DESIGN.md forbids a fifth hue beyond the four wine
-- states ("there must not be one") and check-design-palette.mjs bans warm hues
-- at L < 0.72 as brown and L >= 0.80 as cream -- which is exactly where oak,
-- spice, earth and honey live. Family groups chips and labels them; it does
-- not tint them. See D10 in the design spec.

insert into public.descriptors (slug, label, family, sort) values
  ('red-fruit',   'Red fruit',   'fruit',   10),
  ('black-fruit', 'Black fruit', 'fruit',   20),
  ('citrus',      'Citrus',      'fruit',   30),
  ('stone-fruit', 'Stone fruit', 'fruit',   40),
  ('tropical',    'Tropical',    'fruit',   50),
  ('dried-fruit', 'Dried fruit', 'fruit',   60),
  ('floral',      'Floral',      'floral',  70),
  ('herbal',      'Herbal',      'herbal',  80),
  ('vegetal',     'Vegetal',     'herbal',  90),
  ('oaky',        'Oaky',        'oak',    100),
  ('vanilla',     'Vanilla',     'oak',    110),
  ('smoky',       'Smoky',       'oak',    120),
  ('toasty',      'Toasty',      'oak',    130),
  ('earthy',      'Earthy',      'earth',  140),
  ('mineral',     'Mineral',     'earth',  150),
  ('savoury',     'Savoury',     'earth',  160),
  ('spice',       'Spice',       'spice',  170),
  ('pepper',      'Pepper',      'spice',  180),
  ('reductive',   'Reductive',   'fault',  190),
  ('oxidative',   'Oxidative',   'fault',  200),
  ('corked',      'Corked',      'fault',  210),
  ('volatile',    'Volatile',    'fault',  220)
on conflict (slug) do nothing;
