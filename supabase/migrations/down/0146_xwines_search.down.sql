-- Down for 0146_xwines_search.sql: drop the corpus search function. Nothing
-- else was created and no data was written; the grants die with the function.

drop function if exists public.xwines_search(text, int);
