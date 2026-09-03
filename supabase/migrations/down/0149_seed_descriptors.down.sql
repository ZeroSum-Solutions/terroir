-- Down for 0149.
--
-- Deletes only the descriptors this migration seeded, by slug, so a vocabulary
-- the owner has since extended in a later migration survives. It does NOT
-- truncate the table.
--
-- Any wine_note_descriptors row referencing one of these slugs blocks the
-- delete on the foreign key, which is the correct outcome: a note's confirmed
-- descriptors are user-authored content, and silently cascading them away to
-- revert a seed would destroy the aggregate the page is built on. If this down
-- fails, that is the constraint telling you notes exist -- decide about them
-- deliberately.

delete from public.descriptors
 where slug in (
   'red-fruit','black-fruit','citrus','stone-fruit','tropical','dried-fruit',
   'floral','herbal','vegetal','oaky','vanilla','smoky','toasty',
   'earthy','mineral','savoury','spice','pepper',
   'reductive','oxidative','corked','volatile'
 );
