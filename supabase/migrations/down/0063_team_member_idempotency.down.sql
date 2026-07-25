drop function if exists public.remove_team_member_idempotent(
  uuid,
  uuid,
  text,
  text
);

drop function if exists public.update_team_member_role_idempotent(
  uuid,
  uuid,
  public.membership_role,
  text,
  text
);
