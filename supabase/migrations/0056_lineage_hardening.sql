-- 0056_lineage_hardening.sql
-- Second verify round (GPT-5.6-sol high — wave0-verify-sol.json), fixes:
--
--  S3 (high) wines.lineage_id was directly writable by tenants without
--            re-derivation (the trigger only watched lwin_id/producer/name),
--            letting a manager hand-link two unrelated wines and pass
--            merge_wines' lineage guard. Fix: the trigger now also fires on
--            UPDATE OF lineage_id and recomputes — a client-supplied value
--            is always overwritten by derivation, so lineage_id is
--            effectively derivation-owned. (A future manual link/unlink
--            feature must ship as its own security-definer RPC.)
--  S1        Cross-path derivation race (concurrent first inserts of the
--            same identity, one with LWIN, one without) could create both a
--            name-keyed and an LWIN lineage. Fix: per-identity advisory
--            transaction lock serializes derivation.
--  S4        Renaming a wine never refreshed its LWIN lineage's stored
--            norms, silently breaking future name-fallback adoption. Fix:
--            refresh norms on LWIN lineages when the current spelling
--            differs (name-keyed lineages keep theirs — the norm IS their
--            identity).
--
-- Deliberately NOT addressed here (documented limitations):
--  S2  A later second LWIN identity with identical norms does not revisit
--      earlier no-LWIN adoptions; ambiguity review is OPP-5's queue.
--  S5  wine_list_items still has no (section_id, wine_id) uniqueness; the
--      merge dedupe closes the common case but a concurrent insert can
--      still double-list. Whether that uniqueness is a product invariant
--      is an OPP-8 decision.

create or replace function public.derive_wine_lineage()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_lwin7         text;
  v_producer_norm text;
  v_cuvee_norm    text;
  v_lineage_id    uuid;
  v_match_count   int;
begin
  v_producer_norm := lower(btrim(new.producer));
  v_cuvee_norm    := lower(btrim(new.name));
  v_lwin7 := case
    when new.lwin_id is not null and new.lwin_id ~ '^[0-9]{7}'
      then substr(new.lwin_id, 1, 7)
    else null
  end;

  -- S1: serialize derivation per (restaurant, identity) so the LWIN and
  -- name-fallback paths cannot race each other into two lineages.
  perform pg_advisory_xact_lock(
    hashtextextended(new.restaurant_id::text || '|' || v_producer_norm || '|' || v_cuvee_norm, 42)
  );

  if v_lwin7 is not null then
    select id into v_lineage_id
      from public.wine_lineages
     where restaurant_id = new.restaurant_id and lwin7 = v_lwin7;

    if v_lineage_id is not null then
      -- S4: keep LWIN lineage norms current with the latest spelling so
      -- name-fallback adoption keeps working after corrections.
      update public.wine_lineages
         set producer_norm = v_producer_norm,
             cuvee_norm    = v_cuvee_norm
       where id = v_lineage_id
         and (producer_norm <> v_producer_norm or cuvee_norm <> v_cuvee_norm);
    end if;

    if v_lineage_id is null then
      begin
        -- upgrade a matching name-keyed lineage in place (sets lwin7)
        update public.wine_lineages
           set lwin7 = v_lwin7
         where restaurant_id = new.restaurant_id
           and lwin7 is null
           and producer_norm = v_producer_norm
           and cuvee_norm = v_cuvee_norm
        returning id into v_lineage_id;
      exception when unique_violation then
        v_lineage_id := null;
      end;
    end if;

    if v_lineage_id is null then
      insert into public.wine_lineages (restaurant_id, lwin7, producer_norm, cuvee_norm)
      values (new.restaurant_id, v_lwin7, v_producer_norm, v_cuvee_norm)
      on conflict (restaurant_id, lwin7) where lwin7 is not null do nothing
      returning id into v_lineage_id;
      if v_lineage_id is null then
        select id into v_lineage_id
          from public.wine_lineages
         where restaurant_id = new.restaurant_id and lwin7 = v_lwin7;
      end if;
    end if;
  else
    select count(*), min(id::text)::uuid
      into v_match_count, v_lineage_id
      from public.wine_lineages
     where restaurant_id = new.restaurant_id
       and lwin7 is not null
       and producer_norm = v_producer_norm
       and cuvee_norm = v_cuvee_norm;

    if v_match_count > 1 then
      v_lineage_id := null;
    elsif v_match_count = 0 then
      select id into v_lineage_id
        from public.wine_lineages
       where restaurant_id = new.restaurant_id
         and lwin7 is null
         and producer_norm = v_producer_norm
         and cuvee_norm = v_cuvee_norm;
      if v_lineage_id is null then
        insert into public.wine_lineages (restaurant_id, producer_norm, cuvee_norm)
        values (new.restaurant_id, v_producer_norm, v_cuvee_norm)
        on conflict (restaurant_id, producer_norm, cuvee_norm) where lwin7 is null do nothing
        returning id into v_lineage_id;
        if v_lineage_id is null then
          select id into v_lineage_id
            from public.wine_lineages
           where restaurant_id = new.restaurant_id
             and lwin7 is null
             and producer_norm = v_producer_norm
             and cuvee_norm = v_cuvee_norm;
        end if;
      end if;
    end if;
  end if;

  new.lineage_id := v_lineage_id;
  return new;
end;
$$;

-- S3: lineage_id joins the watched column list — direct writes re-derive.
drop trigger if exists wines_derive_lineage on public.wines;
create trigger wines_derive_lineage
  before insert or update of lwin_id, producer, name, lineage_id
  on public.wines
  for each row execute function public.derive_wine_lineage();
