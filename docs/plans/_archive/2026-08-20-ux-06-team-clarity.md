# Team Clarity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** Let owners recognize active people, distinguish pending access, and understand each existing role at 390px without exposing UUIDs.

**Architecture:** Resolve display identity on the Team server page from the already-scoped membership user IDs through the existing non-persistent service-role admin client, then pass only `name` and `email` to the client component. Keep the existing membership and invitation backends, but render semantic Members and Pending card groups that collapse cleanly on mobile. Centralize copy-only role descriptions in a pure module so tests can lock them to current route permissions.

**Tech Stack:** Next.js 16 Server Components, React 19, Supabase JS admin API through the existing service-role wrapper, TypeScript 5, Tailwind v4, Vitest 4, Playwright 1.59.

**Spec:** [`docs/plans/2026-08-20-high-leverage-ux-portfolio-spec.md`](2026-08-20-high-leverage-ux-portfolio-spec.md), UX-06.

**Dependencies / order:** Execute after UX-05 and UX-07. Reuse UX-05 `ActionDialog` for member removal and invitation revocation and UX-07 44px icon-button treatment. Do not change schemas, invitation delivery, authorization, roles, or membership APIs.

## Global Constraints

- Query identities only for membership user IDs already scoped to the active `restaurantId`.
- No UUID, including a truncated UUID, may be presented as a person's identity.
- No schema migration, transactional-email provider, RBAC platform, permission change, or profile editor.
- Members and Pending must be separate labelled lifecycle groups at desktop and 390px.
- Keep pending invitation Copy link and Revoke actions. Do not promise email delivery.
- Use `renderToStaticMarkup` or the existing `react-dom/client` + `act` Vitest harness; do not add a test utility dependency.
- Use one final commit for this move. Do not make interim commits.
- Do not commit until the implementation diff has an approving Grok 4.6 audit.

---

### Task 1: Define safe member identity and truthful role-copy contracts

**Files:**
- Create: `src/lib/team/member-identities.ts`
- Create: `src/lib/team/member-identities.test.ts`

**Interfaces:**
- Produces: `type MemberRole = "owner" | "manager" | "staff"`.
- Produces: `type ResolvedMemberIdentity = { userId: string; name: string; email: string }`.
- Produces: `resolveMemberIdentities(admin, userIds: readonly string[]): Promise<Map<string, ResolvedMemberIdentity>>`.
- Produces: `ROLE_DESCRIPTIONS: Record<MemberRole, string>` using the short, frozen distinction matrix below; it describes meaningful role differences without dumping every permission.
- Resolution precedence: `user_metadata.full_name`, then `user_metadata.name`, then email local-part converted to words, then `"Team member"`; email fallback is `"Email unavailable"`. Never fall back to `userId`.

- [ ] **Step 1: Write the failing pure-contract tests**

```ts
it("uses recognizable metadata and email without returning UUID identity", async () => {
  const admin = adminWithUsers({
    "u-1": { email: "maria.santos@example.com", user_metadata: { full_name: "Maria Santos" } },
    "u-2": { email: "lee.chen@example.com", user_metadata: {} },
  });
  const result = await resolveMemberIdentities(admin, ["u-1", "u-2", "missing-uuid"]);
  expect(result.get("u-1")).toEqual({ userId: "u-1", name: "Maria Santos", email: "maria.santos@example.com" });
  expect(result.get("u-2")?.name).toBe("Lee Chen");
  expect(result.get("missing-uuid")).toEqual({ userId: "missing-uuid", name: "Team member", email: "Email unavailable" });
  expect([...result.values()].map((entry) => entry.name)).not.toContain("missing-uuid");
});

it("keeps role copy aligned to the audited distinction matrix", () => {
  expect(ROLE_DESCRIPTIONS).toEqual({
    owner: "Full access, including team access.",
    manager: "Manage inventory and wine lists, publish menus, and reconcile.",
    staff: "Scan invoices, record pours, and view restaurant data.",
  });
});
```

- [ ] **Step 2: Run the focused test to verify RED**

Run: `pnpm test -- src/lib/team/member-identities.test.ts`

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement the bounded resolver and role constants**

```ts
export async function resolveMemberIdentities(admin: AdminClient, userIds: readonly string[]) {
  const uniqueIds = [...new Set(userIds)];
  const pairs = await Promise.all(uniqueIds.map(async (userId) => {
    let user: AdminUser | null = null;
    try {
      const { data, error } = await admin.auth.admin.getUserById(userId);
      user = error ? null : data.user;
    } catch {
      // One deleted or unavailable auth user must not fail the whole roster.
    }
    const email = user?.email?.trim() || "Email unavailable";
    return [userId, {
      userId,
      name: displayName(user?.user_metadata, user?.email),
      email,
    }] as const;
  }));
  return new Map(pairs);
}
```

Type the smallest admin-client surface needed rather than coupling the helper to a browser client. Catch both `{ error }` responses and per-ID thrown/rejected lookups inside each mapped lookup so `Promise.all` cannot reject the whole roster. Add a test whose second `getUserById` call throws and prove the first identity plus the neutral fallback both return. Do not call `listUsers`, do not enumerate the auth tenant, and do not accept a restaurant ID in this helper; the caller supplies only its already-scoped IDs.

Perform a one-time read-only inventory of the authenticated app pages and API routes before implementation, using their actual `requireOwner`, `requireRole`, `requireMembership`, `getAuthContext`, UI gates, and RPC role evidence. Record only these audited distinctions in the implementation notes, then freeze the concise copy above:

| Role | Audited distinction |
|---|---|
| Owner | Operational access plus owner-only team invitation, role, removal, and revocation controls. |
| Manager | Operational management including inventory reconciliation and wine-list/menu publishing, without owner-only team administration. |
| Staff | Day-to-day scanning, pours, and authenticated read access, without manager/owner mutation privileges. |

Do not ship a recursive classifier, permission dump, source scanner, or fail-on-new-file test. The unit test locks the concise descriptions, while the one-time audit supplies their evidence. If the audit contradicts this matrix, revise the copy to match code; never change permissions in this move.

- [ ] **Step 4: Run the identity tests to verify GREEN**

Run: `pnpm test -- src/lib/team/member-identities.test.ts`

Expected: PASS, including missing/deleted-auth-user fallback with no UUID display.

---

### Task 2: Resolve identities at the Team server boundary

**Files:**
- Modify: `src/app/(app)/team/(index)/page.tsx` (`TeamPage` scoped identity enrichment, after UX-02's landing route-group move)
- Modify: `src/app/(app)/team/(index)/page.test.tsx`
- Reuse unchanged: `src/lib/supabase/service-role.ts`

**Interfaces:**
- `TeamPage` still queries memberships with `.eq("restaurant_id", restaurantId)` before resolving identities.
- Member props become `{ id, user_id, name, email, role, created_at }`.
- If the service-role client is unavailable or a user lookup fails, the page renders `Team member` / `Email unavailable`; it must not fail the whole roster.

- [ ] **Step 1: Extend the page test with scoped lookup and fallback assertions**

```tsx
it("enriches only active-restaurant membership IDs", async () => {
  mocks.memberships.resolve([{ id: "m-1", user_id: "u-1", role: "manager", created_at: NOW }]);
  mocks.resolveMemberIdentities.mockResolvedValue(new Map([
    ["u-1", { userId: "u-1", name: "Maria Santos", email: "maria@example.com" }],
  ]));
  const tree = await TeamPage();
  expect(mocks.events).toEqual(["eq:restaurant_id:r-1", "resolve:u-1"]);
  expect(mocks.resolveMemberIdentities).toHaveBeenCalledWith(expect.anything(), ["u-1"]);
  expect(mocks.resolveMemberIdentities).not.toHaveBeenCalledWith(expect.anything(), expect.arrayContaining(["other-tenant-user"]));
  expect(findTeamActionsProps(tree).members[0]).toMatchObject({ name: "Maria Santos", email: "maria@example.com" });
});

it("uses neutral text when the admin client is unavailable", async () => {
  mocks.createServiceRoleClient.mockReturnValue(null);
  const tree = await TeamPage();
  expect(findTeamActionsProps(tree).members[0]).toMatchObject({ name: "Team member", email: "Email unavailable" });
});
```

In the page-test query mock, push `eq:${column}:${value}` when `.eq()` runs and have the identity-resolver mock push `resolve:${userIds.join(",")}` before returning. Seed an out-of-tenant row in the unfiltered fixture but have the mocked restaurant predicate return only `u-1`; the exact event sequence above proves scoping occurs before lookup and only returned IDs are resolved.

- [ ] **Step 2: Run the page test to verify RED**

Run: `pnpm test -- 'src/app/(app)/team/(index)/page.test.tsx'`

Expected: FAIL because `TeamPage` currently passes only membership UUID data.

- [ ] **Step 3: Add the scoped server-side enrichment**

```ts
if (membersError) throw membersError; // preserve UX-02 error boundary; never enrich an error fallback
const roster = members ?? []; // null is treated as empty only after an explicitly successful query
const admin = createServiceRoleClient();
const identities = admin
  ? await resolveMemberIdentities(admin, roster.map((member) => member.user_id))
  : new Map();

members={roster.map((member) => ({
  ...member,
  name: identities.get(member.user_id)?.name ?? "Team member",
  email: identities.get(member.user_id)?.email ?? "Email unavailable",
}))}
```

Keep the original restaurant predicate and ordering. Never expose service-role configuration or auth errors to the client.

- [ ] **Step 4: Run page and identity tests to verify GREEN**

Run: `pnpm test -- src/lib/team/member-identities.test.ts 'src/app/(app)/team/(index)/page.test.tsx'`

Expected: PASS.

---

### Task 3: Render recognizable, responsive Members and Pending groups

**Files:**
- Modify: `src/app/(app)/team/team-actions.tsx` (`Member` type, roster/pending markup, role descriptions, responsive actions)
- Create: `src/app/(app)/team/team-actions.test.tsx`
- Modify only as needed: `src/app/(app)/team/team-actions.action-dialog.test.tsx` (created by UX-05; add the minimal `name`/`email` fixture fields required by the extended `Member` type without weakening removal/revocation confirmation coverage)
- Create: `e2e/team-mobile.test.ts`

**Interfaces:**
- Active card primary text is member `name`; secondary text is `email`; `You` is an additional current-user marker, not a replacement identity.
- Lifecycle headings are exactly `Members` and `Pending` (count may follow).
- Pending cards use the invited email as their primary identity, show the pending role and `ROLE_DESCRIPTIONS[invitation.role]`, retain `Copy invite link` and `Revoke invitation`, and never render the raw invitation token or a UUID as identity. Retain Resend only if already functional, but do not describe it as transactional email delivery.
- Every active member card renders `ROLE_DESCRIPTIONS[member.role]`; role descriptions do not alter the existing select values or PATCH body.
- The invite modal help text reads the same derived `ROLE_DESCRIPTIONS[inviteRole]` value shown on the roster card; do not maintain a second, contradictory copy branch.
- Preserve role change, member removal, invite-link copy, invitation revocation, and the `(You)` marker. Every selected Team control touched by this move—Create invite link, role select, remove, copy, revoke, invite Cancel/Generate/Copy/Done—has `min-h-11` (and `min-w-11` when icon-only).
- The Members toolbar uses `flex-wrap` with a bounded gap so its heading and Create invite link control fit at 390px; the Playwright check asserts the toolbar has no overflow and its selected action is at least 44px high.

- [ ] **Step 1: Write failing component tests for identities, groups, actions, and copy**

```tsx
it("renders names and emails in distinct lifecycle groups without UUID text", async () => {
  const { container, root } = await mount(<TeamActions {...props({
    currentUserId: UUID,
    members: [{ id: "m-1", user_id: UUID, name: "Maria Santos", email: "maria@example.com", role: "manager", created_at: NOW }],
    invitations: [{ id: "i-1", token: "secret-token", email: "pending@example.com", role: "staff", created_at: NOW, expires_at: LATER }],
  })} />);
  const headings = [...container.querySelectorAll("h2")].map((node) => node.textContent);
  expect(headings.some((text) => text?.startsWith("Members"))).toBe(true);
  expect(headings.some((text) => text?.startsWith("Pending"))).toBe(true);
  expect(container.textContent).toContain("Maria Santos");
  expect(container.textContent).toContain("maria@example.com");
  expect(container.textContent).toContain("(You)");
  expect(container.textContent).toContain(ROLE_DESCRIPTIONS.manager);
  expect(container.textContent).toContain("pending@example.com");
  expect(container.textContent).toContain(ROLE_DESCRIPTIONS.staff);
  expect(container.textContent).not.toContain("secret-token");
  expect(container.textContent).not.toContain(UUID.slice(0, 8));
  for (const prefix of ["Copy invite link", "Revoke invitation"]) {
    const action = [...container.querySelectorAll<HTMLButtonElement>("button")].find((node) => node.getAttribute("aria-label")?.startsWith(prefix))!;
    expect(action.className).toContain("min-h-11");
  }
  await act(async () => root.unmount());
});
```

At the top of `team-actions.test.tsx`, use `vi.hoisted` to provide `refresh`, mock `next/navigation` so `useRouter()` returns it, and mount with `createRoot` inside `act`. Do not call this client component as a plain function or rely on server static markup. Add interaction tests that change a member role and assert the existing PATCH body, open/confirm member removal through UX-05, copy a pending link, and open/confirm revocation. For every role fixture, assert the active member card shows `ROLE_DESCRIPTIONS[member.role]`. Open the invite modal and assert its Owner, Manager, and Staff help text exactly equals the same `ROLE_DESCRIPTIONS` values as the select changes; no second copy branch is permitted. Assert Pending shows invited email plus role description while the raw token stays absent from rendered text. Assert the selected Team controls listed in Interfaces use the 44px classes; do not broaden the gate to unrelated page controls.

- [ ] **Step 2: Run the component test to verify RED**

Run: `pnpm test -- 'src/app/(app)/team/team-actions.test.tsx'`

Expected: FAIL because the current table truncates `user_id`, uses a different pending heading, and has sub-44px actions.

- [ ] **Step 3: Implement responsive semantic cards**

```tsx
<section aria-labelledby="members-heading">
  <h2 id="members-heading">Members ({members.length})</h2>
  <ul className="grid gap-sm">
    {members.map((member) => (
      <li className="rounded-card border border-hairline bg-canvas p-md sm:grid sm:grid-cols-[1fr_auto]">
        <p className="font-medium">{member.name} {member.user_id === currentUserId && <span>(You)</span>}</p>
        <p className="break-all text-[13px] text-grey">{member.email}</p>
        <p>{ROLE_DESCRIPTIONS[member.role]}</p>
      </li>
    ))}
  </ul>
</section>
```

Apply the same stacked-card structure to Pending, with `invitation.email` as visible identity, the humanized role and `ROLE_DESCRIPTIONS[invitation.role]` beneath it, and only named actions—not `invitation.token`—rendered. Use `min-w-0`, wrapping, and `break-all`/`break-words` for long email addresses; keep each selected action at least 44px. Reuse the UX-05 confirmation states rather than reintroducing `window.confirm`.

- [ ] **Step 4: Add an isolated 390px browser assertion**

```ts
test("team cards fit at 390px and retain pending actions", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await loginWithLocalFixture(page);
  await page.goto("/team");
  await expect(page.getByRole("heading", { name: /Members/ })).toBeVisible();
  await expect(page.getByRole("heading", { name: /Pending/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /Copy invite link/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /Revoke invitation/ })).toBeVisible();
  const createInvite = page.getByRole("button", { name: "Create invite link" });
  await expect(createInvite).toBeVisible();
  expect((await createInvite.boundingBox())?.height).toBeGreaterThanOrEqual(44);
  const toolbar = page.locator('[data-testid="team-toolbar"]');
  expect(await toolbar.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
```

Use an invitation created for the local test run and revoke/clean it in `afterAll`; skip explicitly when local credentials are absent. Never mutate production.

- [ ] **Step 5: Run focused tests**

```bash
pnpm test -- src/lib/team/member-identities.test.ts 'src/app/(app)/team/(index)/page.test.tsx' 'src/app/(app)/team/team-actions.test.tsx' 'src/app/(app)/team/team-actions.action-dialog.test.tsx'
pnpm exec playwright test e2e/team-mobile.test.ts
```

Expected: unit tests pass; Playwright passes with isolated local fixtures or reports its explicit fixture skip.

---

### Task 4: Verify, audit, and create the single move commit

**Files:** All files listed above and no others.

- [ ] **Step 1: Run move verification**

```bash
pnpm test -- src/lib/team/member-identities.test.ts 'src/app/(app)/team/(index)/page.test.tsx' 'src/app/(app)/team/team-actions.test.tsx' 'src/app/(app)/team/team-actions.action-dialog.test.tsx'
pnpm exec tsc --noEmit
pnpm lint
git diff --check
```

Expected: all commands exit 0; record the optional isolated Playwright result separately.

- [ ] **Step 2: Perform the independent task review**

Review the query chain for restaurant scoping before identity lookups, force one identity lookup to throw without losing the remaining roster, scan rendered output for UUID fragments, compare both card and invite-modal role copy against current gates, and inspect 390px wrapping. Confirm role change, remove, copy, revoke, and `(You)` remain present and the selected Team controls meet the 44px floor. Reject any schema/provider/RBAC/permission change.

- [ ] **Step 3: Obtain the mandatory Grok 4.6 pre-commit audit**

Send this plan and the complete UX-06 diff to `x-ai/grok-4.6`. Require `APPROVE` or `REVISE` covering tenant scoping, identity fallbacks, UUID non-disclosure, role-copy truth, mobile layout, pending actions, scope, and tests. Resolve every blocking or important finding, rerun verification, and re-audit until `APPROVE`.

- [ ] **Step 4: Stage only the exact UX-06 paths and commit once**

```bash
git add src/lib/team/member-identities.ts src/lib/team/member-identities.test.ts \
  'src/app/(app)/team/(index)/page.tsx' \
  'src/app/(app)/team/(index)/page.test.tsx' \
  'src/app/(app)/team/team-actions.tsx' \
  'src/app/(app)/team/team-actions.test.tsx' \
  'src/app/(app)/team/team-actions.action-dialog.test.tsx' \
  e2e/team-mobile.test.ts
git commit -m "feat: clarify team member identities and roles"
```
