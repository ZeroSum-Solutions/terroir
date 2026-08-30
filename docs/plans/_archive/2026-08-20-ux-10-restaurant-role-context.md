# Restaurant and Role Context Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** Keep the current restaurant and human-readable role visible throughout the authenticated app while removing the unavailable Voice action.

**Architecture:** Render a small server-safe context label inside the existing persistent authenticated layout, using the restaurant and role already returned by `getAuthContext`. Do not add a context fetch, switcher, route, or navigation item. Simplify the existing mobile FAB from four actions to the three working actions and remove the now-unused disabled-action branch.

**Tech Stack:** Next.js 16.2.4 App Router layout, React 19.2.4, TypeScript 5, Tailwind CSS 4, lucide-react, Vitest 4.1.4, happy-dom.

**Spec:** [`docs/plans/2026-08-20-high-leverage-ux-portfolio-spec.md`](./2026-08-20-high-leverage-ux-portfolio-spec.md), UX-10.

## Global Constraints

- Preserve the approved shell identity and all four primary destinations: Scan, Cellar, Lists, Insights.
- Add no restaurant switcher, tenant onboarding, speech support, permission change, or navigation redesign.
- Treat `390px` as the minimum review width; context must not cover the settings trigger or bottom navigation.
- Display only the current auth-context restaurant name and role; do not expose identifiers.
- Human role labels are exactly `Owner`, `Manager`, and `Staff` and describe no new capability.
- Remove all user-facing Voice and coming-soon copy from the FAB.
- Read `node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/layout.md` and `node_modules/next/dist/docs/01-app/01-getting-started/05-server-and-client-components.md` before implementation. Keep the layout a Server Component and pass serializable strings to the shell label.
- Use test-driven development and create no interim commit. The move receives one final commit only after the Grok 4.6 gate passes.

---

## File Map

- Create `src/app/(app)/shell-context.tsx`: restaurant and role label plus exhaustive role formatter.
- Create `src/app/(app)/shell-context.test.tsx`: identity, nullable fallback, and exact compact-class coverage.
- Create `src/app/(app)/fab.test.tsx`: three-action and no-Voice regression coverage.
- Create `src/app/(app)/nav-links.test.tsx`: preservation coverage for the four primary destinations.
- Create `src/app/(app)/layout.test.tsx`: automated proof that the real layout mounts context and preserves mobile shell spacing.
- Modify `src/app/(app)/layout.tsx`: place the context label in the persistent header and update stale FAB comments.
- Modify `src/app/(app)/fab.tsx`: remove Voice, its icon, and unused disabled-action machinery.

### Task 1: Render restaurant and role in the persistent shell

**Files:**
- Create: `src/app/(app)/shell-context.tsx`
- Create: `src/app/(app)/shell-context.test.tsx`
- Modify: `src/app/(app)/layout.tsx`

**Interfaces:**
- Consumes: `{ restaurantName: string | null; role: "owner" | "manager" | "staff" }` already available in `AppLayout`.
- Produces: `<ShellContext restaurantName={restaurantName} role={userRole} />` and `roleLabel(role): "Owner" | "Manager" | "Staff"`.

- [ ] **Step 1: Write the failing shell-context tests**

```tsx
it.each([
  ["owner", "Owner"],
  ["manager", "Manager"],
  ["staff", "Staff"],
] as const)("shows restaurant and %s role", (role, label) => {
  document.body.innerHTML = renderToStaticMarkup(
    <ShellContext restaurantName="Bar Norman" role={role} />,
  );
  const context = document.querySelector('[data-shell-context="true"]')!;
  expect(context.textContent).toContain("Bar Norman");
  expect(context.textContent).toContain(label);
  expect(context.getAttribute("aria-label")).toBeNull();
});
```

Add `it.each([null, "", "   "])` asserting the visible fallback is `Unnamed restaurant`, because the existing onboarding modal can coexist with a null, empty, or whitespace-only restaurant name. Query visible content through `data-shell-context="true"`; do not add an `aria-label` that would replace the visible restaurant/role text as the accessible name. Assert the exact compact tokens from Step 3.

- [ ] **Step 2: Run the shell-context test and confirm RED**

Run:

```bash
pnpm exec vitest run 'src/app/(app)/shell-context.test.tsx'
```

Expected: FAIL because `ShellContext` does not exist.

- [ ] **Step 3: Implement and mount the compact server component**

Use an exhaustive role map:

```ts
type Role = "owner" | "manager" | "staff";

const ROLE_LABEL: Record<Role, string> = {
  owner: "Owner",
  manager: "Manager",
  staff: "Staff",
};
```

Render a `role="group" data-shell-context="true"` container immediately after the Terroir home link. Its visible restaurant span and role pill are the accessible contents; do not set `aria-label`. Use these exact tokens so the 390px contract is reviewable:

```tsx
<div
  role="group"
  data-shell-context="true"
  className="ml-sm flex min-w-0 items-center gap-xs border-l border-hairline pl-sm md:ml-md md:gap-sm md:pl-md"
>
  <span className="max-w-[112px] truncate text-[11px] font-medium text-ink md:max-w-[220px] md:text-[12px]">
    {restaurantName?.trim() || "Unnamed restaurant"}
  </span>
  <span className="shrink-0 rounded-pill bg-beige px-sm py-2xs text-[10px] font-medium uppercase tracking-wide text-ink-soft">
    {roleLabel(role)}
  </span>
</div>
```

Keep both values visible on mobile and desktop and do not add a tooltip containing an identifier. In `layout.tsx`, add `shrink-0` to the TERR​OIR home link and to the existing `ml-auto` email/Settings wrapper so neither edge control surrenders its target to the truncating middle context.

In `layout.tsx`, mount:

```tsx
<ShellContext restaurantName={restaurantName} role={userRole} />
```

Do not remove the existing onboarding condition for a null or blank name. Keep user email desktop-only and keep Settings at the far right.

- [ ] **Step 4: Run the shell-context tests and confirm GREEN**

Run the Step 2 command.

Expected: all role and fallback cases PASS.

### Task 2: Remove the unavailable Voice action and disabled-action machinery

**Files:**
- Create: `src/app/(app)/fab.test.tsx`
- Modify: `src/app/(app)/fab.tsx`
- Modify: `src/app/(app)/layout.tsx`

**Interfaces:**
- Consumes: the existing `/scan`, `/cellar?mode=pour`, and `/cellar?mode=eightysix` destinations.
- Produces: exactly three interactive controls inside the FAB menu, named `Scan invoice`, `Pour`, and `86 a wine`.

- [ ] **Step 1: Write the failing FAB regression test**

Document the navigation harness explicitly so both hooks used by `Fab` are safe:

```ts
const navigation = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock("next/navigation", () => ({
  usePathname: () => "/cellar",
  useRouter: () => ({ push: navigation.push }),
}));
```

Render `<Fab />` to static markup and count every interactive element inside `[role="menu"]`, not only elements already carrying `role="menuitem"` (the current disabled Voice button lacks that role and would otherwise evade the test):

```tsx
const menu = document.querySelector<HTMLElement>('[role="menu"]')!;
const actions = [...menu.querySelectorAll<HTMLElement>("a, button")];
expect(actions).toHaveLength(3);
expect(actions.map((action) => action.getAttribute("aria-label"))).toEqual([
  "Scan invoice",
  "Pour",
  "86 a wine",
]);
expect(document.body.textContent).not.toContain("Voice command");
expect(document.body.textContent).not.toContain("Coming in v2");
```

Also assert the three anchors retain `/scan`, `/cellar?mode=pour`, and `/cellar?mode=eightysix`. Expected RED must report four interactive controls before the fix, including `Voice command (Coming in v2)`; this proves the test cannot pass by ignoring the disabled branch.

- [ ] **Step 2: Run the FAB test and confirm RED**

Run:

```bash
pnpm exec vitest run 'src/app/(app)/fab.test.tsx'
```

Expected: FAIL because the menu still contains Voice and has four action entries.

- [ ] **Step 3: Delete only the unavailable action path**

Remove `Mic` from the lucide import and delete the Voice object from `ACTIONS`. Make `Action.href` a required `string`. Because no working action is disabled, remove `disabled` and `disabledReason` from `Action`, delete disabled checks in `onActivate`, remove disabled styling and the disabled title/button branch in `ActionPill`, and delete the final no-href `<button>` fallback branch entirely. `ActionPill` must have one return path: the `Link` used by all three actions. Update the file header to say the speed dial exposes three working actions. Update the stale layout comment to `Scan / Pour / 86`.

Do not change FAB positioning, Escape/outside-click behavior, route hiding, animation, or the three working hrefs.

- [ ] **Step 4: Run the FAB test and confirm GREEN**

Run the Step 2 command.

Expected: the three-action and no-Voice assertions PASS.

### Task 3: Lock the four existing primary destinations

**Files:**
- Create: `src/app/(app)/nav-links.test.tsx`
- Verify without modifying: `src/app/(app)/nav-links.tsx`

**Interfaces:**
- Consumes: `DesktopNavLinks` and `MobileNavLinks` with role `staff` and a mocked pathname.
- Produces: regression evidence that Scan, Cellar, Lists, and Insights remain present with unchanged hrefs.

- [ ] **Step 1: Write the navigation preservation test**

```tsx
it.each([DesktopNavLinks, MobileNavLinks])(
  "preserves the four primary destinations",
  (Navigation) => {
    document.body.innerHTML = renderToStaticMarkup(<Navigation role="staff" />);
    expect([...document.querySelectorAll("a")].map((link) => [
      link.textContent?.trim(),
      link.getAttribute("href"),
    ])).toEqual([
      ["Scan", "/scan"],
      ["Cellar", "/cellar"],
      ["Lists", "/lists"],
      ["Insights", "/insights"],
    ]);
  },
);
```

Mock `usePathname` as `/cellar` and assert Cellar has `aria-current="page"` in both renderings.

- [ ] **Step 2: Run the preservation test**

Run:

```bash
pnpm exec vitest run 'src/app/(app)/nav-links.test.tsx'
```

Expected: PASS against the unchanged four-destination navigation. If it fails, repair only the test fixture unless the failure proves this UX-10 implementation accidentally changed `nav-links.tsx`.

### Task 4: Prove the real layout mounts the context

**Files:**
- Create: `src/app/(app)/layout.test.tsx`
- Test: `src/app/(app)/layout.tsx`

- [ ] **Step 1: Write and run the failing layout wiring test**

Mock `getAuthContext`, `redirect`, `RestaurantProvider`, `ToastWrapper`, `SettingsDropdown`, both navigation components, `Fab`, and `OnboardingModal` with deterministic elements; keep `ShellContext` real. Return a manager at `Bar Norman`, await `AppLayout({ children: <p>Dashboard</p> })`, render it, and assert `[data-shell-context="true"]` contains `Bar Norman` and `Manager`, the TERR​OIR link has `shrink-0`, the `ml-auto` email/Settings wrapper has `shrink-0`, and both primary-nav mocks remain mounted. Repeat with `restaurantName: null`; assert `Unnamed restaurant` and the onboarding mock both render.

Run:

```bash
pnpm exec vitest run 'src/app/(app)/layout.test.tsx'
```

Expected: RED before the Task 1 mount; GREEN after it. This is the automated layout proof rather than relying only on the isolated label test.

### Task 5: Verify, audit, and create the single UX-10 commit

**Files:** all created/modified files listed in this plan. `nav-links.tsx` must remain unchanged.

- [ ] **Step 1: Run focused and repository verification**

```bash
pnpm exec vitest run \
  'src/app/(app)/shell-context.test.tsx' \
  'src/app/(app)/fab.test.tsx' \
  'src/app/(app)/nav-links.test.tsx' \
  'src/app/(app)/layout.test.tsx'
pnpm test
pnpm exec tsc --noEmit
pnpm lint
git diff --check -- \
  'src/app/(app)/shell-context.tsx' \
  'src/app/(app)/shell-context.test.tsx' \
  'src/app/(app)/fab.tsx' \
  'src/app/(app)/fab.test.tsx' \
  'src/app/(app)/layout.tsx' \
  'src/app/(app)/layout.test.tsx' \
  'src/app/(app)/nav-links.test.tsx'
git diff --exit-code -- 'src/app/(app)/nav-links.tsx'
```

Expected: focused/full tests, type checking, lint, diff check, and unchanged-nav check all exit `0`.

- [ ] **Step 2: Complete responsive and keyboard evidence**

Inspect one authenticated isolated fixture at `390px` and desktop width. Verify restaurant and role stay visible without covering TERR​OIR or Settings, the four bottom tabs remain reachable, the FAB exposes only three working actions, Escape closes it, and tab focus never reaches hidden actions. Do not use a production bypass session or mutate shared data.

- [ ] **Step 3: Complete the Grok 4.6 pre-commit audit**

Give `x-ai/grok-4.6` the UX-10 spec section, this plan, focused test evidence, and the complete unstaged diff for only the listed files. Require an `APPROVE` or `REVISE` verdict and findings classified as blocking, important, or advisory. For `REVISE`, fix every blocking and important finding, rerun Steps 1–2, and re-audit the complete revised diff. Do not commit until the verdict is `APPROVE` with zero blocking and zero important findings.

- [ ] **Step 4: Stage exact paths and commit once**

```bash
git add \
  'src/app/(app)/shell-context.tsx' \
  'src/app/(app)/shell-context.test.tsx' \
  'src/app/(app)/fab.tsx' \
  'src/app/(app)/fab.test.tsx' \
  'src/app/(app)/layout.tsx' \
  'src/app/(app)/layout.test.tsx' \
  'src/app/(app)/nav-links.test.tsx'
git commit -m "feat: show restaurant and role context"
```

Expected: one UX-10 commit containing only the shell context, Voice removal, and regression tests.
