-- Reverse of 0057_atomic_idempotent_commands.sql.

drop function if exists public.accept_invitation_idempotent(
  text,
  text,
  text
);
drop function if exists public.open_bottle_from_inventory(uuid, uuid);

alter table public.invitations
  drop constraint if exists invitations_invitable_role_check;
