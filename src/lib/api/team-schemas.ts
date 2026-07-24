import { z } from "zod";

export const TeamIdParamsSchema = z.object({
  id: z.string().uuid("id must be a valid UUID"),
});

export const AcceptInviteBodySchema = z.object({
  token: z.string().regex(/^[a-f0-9]{48}$/, "Invalid invitation token."),
});

export const CreateInviteBodySchema = z
  .object({
    email: z.string().trim().toLowerCase().pipe(z.string().email()),
    role: z.enum(["manager", "staff"]).default("staff"),
  })
  .strict();

export const UpdateMemberRoleBodySchema = z
  .object({
    role: z.enum(["owner", "manager", "staff"]),
  })
  .strict();
