# Mobile List Editor Survival Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** Keep every essential wine-list editing action reachable and understandable at 390px, including recovery from a list with no sections.

**Architecture:** Retain the existing editor and APIs, but separate the dense top action rail into an intentional wrapping/scrolling mobile layout with visible labels and 44px targets. Extend the current mobile section selector with add, rename, delete, and template controls; reuse the UX-05 confirmation primitive for section deletion. Fix the login return URL at the server-page boundary.

**Tech Stack:** Next.js 16 App Router, React 19, TypeScript 5, Tailwind v4, existing dnd-kit for pointer/touch reorder only, Vitest 4, Playwright 1.59.

**Spec:** [`docs/plans/2026-08-20-high-leverage-ux-portfolio-spec.md`](2026-08-20-high-leverage-ux-portfolio-spec.md), UX-04.

**Dependencies / order:** Execute after UX-05 so mobile section deletion reuses `ActionDialog`. Preserve existing pointer/touch drag-and-drop; keyboard reordering is explicitly outside this move.

## Global Constraints

- Treat 390px as the minimum supported review width and prevent document-level horizontal overflow.
- Selected interactive targets must be at least 44px and icon-only controls must have accessible names.
- Preserve existing APIs, template set, dnd-kit behavior, and `DESIGN.md` tokens.
- Do not add keyboard reorder, a template system, collaboration, or redesign the editor.
- Use `renderToStaticMarkup` or the existing `react-dom/client` + `act` harness; do not add a test utility dependency.
- Use one final commit for this move. Do not make interim commits.
- Do not commit until the implementation diff has an approving Grok 4.6 audit.

---

### Task 1: Make the header and template selector mobile-safe

**Files:**
- Modify: `src/app/(app)/lists/[id]/wine-list-editor.tsx` (`WineListEditor` header action rail)
- Modify: `src/app/(app)/lists/[id]/components/template-picker.tsx` (`TemplatePicker` target sizing and compact mobile presentation)
- Create: `src/app/(app)/lists/[id]/wine-list-editor.mobile.test.tsx`
- Create: `src/app/(app)/lists/[id]/components/template-picker.test.tsx`

**Interfaces:**
- `TemplatePicker` retains `current`, `onChange`, and `disabled`; an optional `ariaLabelledby?: string` can associate its group with the mobile heading.
- Header actions keep their existing URLs and callbacks. Labels remain visible at 390px; no action becomes icon-only.
- The editor renders exactly one dedicated `<div data-testid="mobile-list-controls" className="md:hidden">` containing all mobile header actions, section controls, and mobile `TemplatePicker` chrome; every mobile assertion queries inside it so the still-mounted desktop DOM cannot satisfy the test.
- `wine-list-editor.mobile.test.tsx` must mock `next/navigation` (`useRouter` returning `{ refresh: vi.fn() }`), `@dnd-kit/core` (`DndContext` passthrough plus inert `useSensor`/`useSensors`), `@dnd-kit/sortable` (`SortableContext` passthrough, inert `useSortable`, and `verticalListSortingStrategy`), and `@dnd-kit/utilities` (`CSS.Transform.toString`). Define local `section(overrides?)` and `editorProps(overrides?)` fixtures in this test file; do not reference an undeclared helper.

Use this complete local harness shape, filling the `list` object with all `WineList` row fields from `src/types/database.ts`:

```tsx
import { act, type ReactElement } from "react";
import { createRoot } from "react-dom/client";

const mocks = vi.hoisted(() => ({ refresh: vi.fn(), fetch: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: mocks.refresh }) }));
vi.mock("@dnd-kit/core", () => ({
  DndContext: ({ children }: { children: React.ReactNode }) => children,
  closestCenter: vi.fn(), PointerSensor: class {}, TouchSensor: class {},
  useSensor: vi.fn(() => ({})), useSensors: vi.fn((...sensors) => sensors),
}));
vi.mock("@dnd-kit/sortable", () => ({
  SortableContext: ({ children }: { children: React.ReactNode }) => children,
  verticalListSortingStrategy: {},
  useSortable: () => ({ attributes: {}, listeners: {}, setNodeRef: vi.fn(), transform: null, transition: undefined, isDragging: false }),
}));
vi.mock("@dnd-kit/utilities", () => ({ CSS: { Transform: { toString: () => undefined } } }));

function section(overrides: Partial<WineListEditorSection> = {}): WineListEditorSection {
  return { id: "section-reds", name: "Reds", position: 0, wine_list_id: "list-1", wine_list_items: [], ...overrides };
}
function completeListFixture(): React.ComponentProps<typeof WineListEditor>["list"] {
  return { archived: false, created_at: "2026-08-20T00:00:00.000Z", description: null, id: "list-1", is_published: false, last_published_at: null, name: "Dinner", restaurant_id: "restaurant-1", show_bin_codes: false, slug: null, template: "classic", theme: null, updated_at: "2026-08-20T00:00:00.000Z" };
}
function editorProps(overrides: Partial<React.ComponentProps<typeof WineListEditor>> = {}): React.ComponentProps<typeof WineListEditor> {
  return { list: completeListFixture(), sections: [section()], brandKit: null, canManageBranding: true, ...overrides };
}
async function mount(element: ReactElement) { const container = document.createElement("div"); document.body.append(container); const root = createRoot(container); await act(async () => root.render(element)); return { container, root }; }
function button(root: ParentNode, name: string) { return [...root.querySelectorAll<HTMLButtonElement>("button")].find((node) => node.textContent?.trim() === name || node.getAttribute("aria-label") === name)!; }
async function change(input: HTMLInputElement, value: string) { await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value); input.dispatchEvent(new Event("input", { bubbles: true })); }); }
beforeEach(() => { vi.clearAllMocks(); vi.stubGlobal("fetch", mocks.fetch.mockResolvedValue(new Response(null, { status: 204 }))); });
afterEach(() => vi.unstubAllGlobals());
```

- [ ] **Step 1: Write failing markup tests for labels, groups, and 44px targets**

```tsx
it("keeps every header action labelled in the mobile-only rail", () => {
  document.body.innerHTML = renderToStaticMarkup(<WineListEditor {...editorProps()} />);
  const mobile = document.querySelector<HTMLElement>('[data-testid="mobile-list-controls"]')!;
  expect(mobile.className).toContain("md:hidden");
  for (const name of ["Download PDF", "Toast Export", "CSV", "Preview", "Print", "Publish"]) {
    const action = [...mobile.querySelectorAll<HTMLElement>("button,a")].find((node) => node.textContent?.trim() === name)!;
    expect(action.className).toContain("min-h-11");
  }
});

it("exposes the template choices as a labelled group with touch-sized buttons", () => {
  document.body.innerHTML = renderToStaticMarkup(<TemplatePicker current="classic" onChange={vi.fn()} ariaLabelledby="mobile-template-heading" />);
  expect(document.querySelector('[role="group"]')?.getAttribute("aria-labelledby")).toBe("mobile-template-heading");
  const classic = [...document.querySelectorAll<HTMLButtonElement>("button")].find((node) => node.textContent?.trim() === "Classic")!;
  expect(classic.className).toContain("min-h-11");
});
```

- [ ] **Step 2: Run the focused tests to verify RED**

Run: `pnpm test -- 'src/app/(app)/lists/[id]/wine-list-editor.mobile.test.tsx' 'src/app/(app)/lists/[id]/components/template-picker.test.tsx'`

Expected: FAIL because mobile labels are hidden and `TemplatePicker` has neither labelled-group semantics nor the target floor.

- [ ] **Step 3: Implement the intentional mobile action layout**

```tsx
<div aria-label="List actions" className="flex max-w-full flex-wrap gap-xs md:justify-end">
  <button className="inline-flex min-h-11 items-center gap-xs ...">
    <Download aria-hidden />
    <span>{generatingPdf ? "Generating PDF" : "Download PDF"}</span>
  </button>
  {/* Preserve each existing handler/link and use the same labelled pattern. */}
</div>
```

Render the single mobile wrapper around the mobile header, section, and template chrome; keep the desktop rail in its existing `hidden md:*` branch. Use wrap-only layout (`flex-wrap`/responsive grid) rather than document-level scrolling, a disclosure, or a custom menu. Update `TemplatePicker` to render `role="group"`, a stable selected indication (`aria-pressed`), and `min-h-11` controls.

- [ ] **Step 4: Run focused tests to verify GREEN**

Run: `pnpm test -- 'src/app/(app)/lists/[id]/wine-list-editor.mobile.test.tsx' 'src/app/(app)/lists/[id]/components/template-picker.test.tsx'`

Expected: PASS.

---

### Task 2: Expose mobile section operations and zero-section recovery

**Files:**
- Modify: `src/app/(app)/lists/[id]/wine-list-editor.tsx` (`activeSection`, mobile section controls, `addSection`, rename state, `deleteTarget`, zero-section branch)
- Extend: `src/app/(app)/lists/[id]/wine-list-editor.mobile.test.tsx`

**Interfaces:**
- Mobile controls call the existing `addSection`, `commitRename`, `cancelRename`, and `setDeleteTarget` paths.
- Section deletion uses UX-05 `ActionDialog`; no additional confirmation primitive is allowed.
- When `sections.length === 0`, render a visible `Add first section` button that calls `addSection`.
- Activating `Rename {section}` in the mobile-only container replaces the selected section label with a visible `<input aria-label="Section name">`. Enter commits, Escape cancels without a PATCH, and blur commits once. Use the same rename state and handlers as desktop rather than a second rename implementation.

- [ ] **Step 1: Write failing tests for the mobile action set and recovery state**

```tsx
it("shows section add, rename, delete, and template actions in the mobile-only controls", () => {
  document.body.innerHTML = renderToStaticMarkup(<WineListEditor {...editorProps({ sections: [section()] })} />);
  const mobile = document.querySelector<HTMLElement>('[data-testid="mobile-list-controls"]')!;
  expect(mobile.className).toContain("md:hidden");
  for (const label of ["Add section", "Rename Reds", "Delete Reds"]) {
    const control = mobile.querySelector<HTMLElement>(`[aria-label="${label}"]`) ?? [...mobile.querySelectorAll<HTMLButtonElement>("button")].find((node) => node.textContent?.trim() === label)!;
    expect(control.className).toContain("min-h-11");
  }
  expect(mobile.textContent).toContain("Template");
});

it.each([
  ["Enter", "PATCH"],
  ["Escape", null],
] as const)("handles %s from the visible mobile rename input", async (key, method) => {
  const { container, root } = await mount(<WineListEditor {...editorProps({ sections: [section()] })} />);
  const mobile = container.querySelector<HTMLElement>('[data-testid="mobile-list-controls"]')!;
  await act(async () => button(mobile, "Rename Reds").click());
  const input = mobile.querySelector<HTMLInputElement>('input[aria-label="Section name"]')!;
  expect(input).not.toBeNull();
  await change(input, "Cellar Reds");
  await act(async () => input.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true })));
  if (method) expect(fetch).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ method }));
  else expect(fetch).not.toHaveBeenCalled();
  await act(async () => root.unmount());
});

it("commits the visible mobile rename once on blur", async () => {
  const { container, root } = await mount(<WineListEditor {...editorProps({ sections: [section()] })} />);
  const mobile = container.querySelector<HTMLElement>('[data-testid="mobile-list-controls"]')!;
  await act(async () => button(mobile, "Rename Reds").click());
  const input = mobile.querySelector<HTMLInputElement>('input[aria-label="Section name"]')!;
  await change(input, "Cellar Reds");
  await act(async () => input.dispatchEvent(new FocusEvent("blur", { bubbles: true })));
  expect(fetch).toHaveBeenCalledTimes(1);
  await act(async () => root.unmount());
});

it("deletes the selected mobile section target only after confirmation", async () => {
  const target = section({ id: "section-reds", name: "Reds" });
  const { container, root } = await mount(<WineListEditor {...editorProps({ sections: [target] })} />);
  const mobile = container.querySelector<HTMLElement>('[data-testid="mobile-list-controls"]')!;
  await act(async () => button(mobile, "Delete Reds").click());
  expect(mocks.fetch).not.toHaveBeenCalled();
  await act(async () => button(container.querySelector('[role="dialog"]')!, "Delete section").click());
  expect(mocks.fetch).toHaveBeenCalledWith("/api/wine-list-sections/section-reds", expect.objectContaining({ method: "DELETE" }));
  await act(async () => root.unmount());
});

it("offers recovery when the list has no sections", () => {
  document.body.innerHTML = renderToStaticMarkup(<WineListEditor {...editorProps({ sections: [] })} />);
  expect(document.querySelector("h2")?.textContent).toBe("Start your list");
  const recovery = [...document.querySelectorAll<HTMLButtonElement>("button")].find((node) => node.textContent?.trim() === "Add first section")!;
  expect(recovery.disabled).toBe(false);
});
```

- [ ] **Step 2: Run the focused test to verify RED**

Run: `pnpm test -- 'src/app/(app)/lists/[id]/wine-list-editor.mobile.test.tsx'`

Expected: FAIL because rename/delete/template are desktop-only and the empty editor renders no recovery control.

- [ ] **Step 3: Implement the mobile editor controls with existing handlers**

```tsx
{sections.length === 0 ? (
  <section className="rounded-card border border-dashed border-hairline p-lg text-center">
    <h2 className="font-serif text-[22px]">Start your list</h2>
    <p>Add a section before adding wines.</p>
    <button type="button" onClick={addSection} className="mt-md min-h-11 rounded-pill bg-primary px-md text-white">Add first section</button>
  </section>
) : (
  <>
    <label htmlFor="mobile-section">Section</label>
    <select id="mobile-section" className="min-h-11 ...">...</select>
    {editingSectionId === currentSection.id ? (
      <input aria-label="Section name" value={editSectionName} onChange={...} onKeyDown={...} onBlur={commitRename} />
    ) : (
    <div className="mt-sm grid grid-cols-3 gap-xs">
      <button aria-label={`Rename ${currentSection.name}`} onClick={() => startRename(currentSection)} className="min-h-11 ...">Rename</button>
      <button aria-label={`Delete ${currentSection.name}`} onClick={() => setDeleteTarget(currentSection)} className="min-h-11 ...">Delete</button>
      <button onClick={addSection} className="min-h-11 ...">Add section</button>
    </div>
    )}
    <h2 id="mobile-template-heading">Template</h2>
    <TemplatePicker ariaLabelledby="mobile-template-heading" ... />
  </>
)}
```

Place this fragment inside the one `mobile-list-controls` wrapper created in Task 1; do not add a second `md:hidden` wrapper. Reuse the inline rename input and its Enter/Escape/blur behavior at mobile width, including the existing `editInputRef` focus path. Ensure Escape cancels before blur can commit, guard the commit path so an Enter-triggered state change plus blur cannot issue two PATCH calls, and pass the selected `currentSection` object to `setDeleteTarget`. Do not add keyboard sensors or change either reorder handler.

- [ ] **Step 4: Run focused tests to verify GREEN**

Run: `pnpm test -- 'src/app/(app)/lists/[id]/wine-list-editor.mobile.test.tsx' 'src/app/(app)/lists/[id]/wine-list-editor.action-dialog.test.tsx'`

Expected: PASS, including the UX-05 section-deletion regression.

---

### Task 3: Correct the unauthenticated return path and prove 390px behavior

**Files:**
- Modify: `src/app/(app)/lists/[id]/page.tsx` (`WineListEditorPage` login redirect)
- Create: `src/app/(app)/lists/[id]/page.test.tsx`
- Create: `e2e/mobile-list-editor.test.ts`

**Interfaces:**
- Unauthenticated redirect is exactly `/login?next=/lists/${id}`.
- Playwright fixture data is isolated to the test run and removed in `afterAll`; never use the shared production database.
- `page.test.tsx` uses `vi.hoisted` mocks for `requireMembership`, `redirect`, and `notFound`; `redirect` throws a local sentinel error containing its URL. Mock `./wine-list-editor` before importing the page so the redirect branch needs no client or dnd-kit runtime.

- [ ] **Step 1: Write the failing redirect test**

```tsx
it("returns unauthenticated users to the canonical list editor URL", async () => {
  mocks.requireMembership.mockResolvedValue(NextResponse.json({}, { status: 401 }));
  mocks.redirect.mockImplementation((url: string) => { throw new Error(`NEXT_REDIRECT:${url}`); });
  await expect(WineListEditorPage({ params: Promise.resolve({ id: "list-1" }) }))
    .rejects.toThrow("NEXT_REDIRECT:/login?next=/lists/list-1");
  expect(mocks.redirect).toHaveBeenCalledWith("/login?next=/lists/list-1");
});
```

- [ ] **Step 2: Run the page test to verify RED**

Run: `pnpm test -- 'src/app/(app)/lists/[id]/page.test.tsx'`

Expected: FAIL because the redirect currently contains `/wine-list/list-1`.

- [ ] **Step 3: Make the one-line redirect correction**

```ts
redirect(`/login?next=/lists/${id}`);
```

- [ ] **Step 4: Add the isolated 390px Playwright check**

```ts
test("essential editor actions stay reachable at 390px", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await loginWithLocalFixture(page);
  await page.goto(`/lists/${fixture.listId}`);
  await expect(page.getByRole("button", { name: "Add section" })).toBeVisible();
  await expect(page.getByRole("button", { name: /Rename/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /Delete/ })).toBeVisible();
  const mobile = page.locator('[data-testid="mobile-list-controls"]:visible');
  await expect(mobile.getByText("Template", { exact: true })).toBeVisible();
  for (const label of ["Download PDF", "Toast Export", "CSV", "Preview", "Print", "Publish"]) {
    const action = mobile.getByRole("button", { name: label, exact: true })
      .or(mobile.getByRole("link", { name: label, exact: true })).first();
    await expect(action).toBeVisible();
    expect(await action.evaluate((node) => node.getBoundingClientRect().height)).toBeGreaterThanOrEqual(44);
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
```

Import fixture creation and cleanup from the existing `e2e/fixtures/local-restaurant.ts` when that helper exists; otherwise define `createLocalWineListFixture()` and `deleteLocalWineListFixture()` in `e2e/mobile-list-editor.test.ts` itself. The helper must assert its Supabase URL is localhost before writing. Create the list and section through that local service-role fixture, skip when local fixture credentials are absent, and delete the list in `afterAll`. Do not point the test at production. In Playwright, select the visible mobile rail or locator (`[data-testid="mobile-list-controls"]:visible`) before querying labels; hidden desktop controls must never satisfy the assertions. Use the button-or-link locator and bounding-box loop shown above for the six visible header actions.

- [ ] **Step 5: Run the focused unit and browser checks**

```bash
pnpm test -- 'src/app/(app)/lists/[id]/page.test.tsx' 'src/app/(app)/lists/[id]/wine-list-editor.mobile.test.tsx' 'src/app/(app)/lists/[id]/components/template-picker.test.tsx'
pnpm exec playwright test e2e/mobile-list-editor.test.ts
```

Expected: unit tests pass; Playwright passes with local isolated credentials or reports its explicit fixture skip.

---

### Task 4: Verify, audit, and create the single move commit

**Files:** All files listed above and no others.

- [ ] **Step 1: Run move verification**

```bash
pnpm test -- 'src/app/(app)/lists/[id]/page.test.tsx' 'src/app/(app)/lists/[id]/wine-list-editor.mobile.test.tsx' 'src/app/(app)/lists/[id]/components/template-picker.test.tsx' 'src/app/(app)/lists/[id]/wine-list-editor.action-dialog.test.tsx'
pnpm exec tsc --noEmit
pnpm lint
git diff --check
```

Expected: all commands exit 0; run the Playwright command from Task 3 when fixtures are available and record a skip separately from a pass.

- [ ] **Step 2: Perform the independent task review**

Review at exactly 390px and keyboard-only. Reject hidden labels, document horizontal overflow, a sub-44px selected control, a zero-section dead end, any new reorder behavior, or any new API/template system.

- [ ] **Step 3: Obtain the mandatory Grok 4.6 pre-commit audit**

Send this plan and the complete UX-04 diff to `x-ai/grok-4.6`. Require `APPROVE` or `REVISE` for 390px reachability, target size, zero-section recovery, canonical redirect, scope boundaries, and tests. Resolve all blocking or important findings, rerun verification, and re-audit until `APPROVE`.

- [ ] **Step 4: Stage only the exact UX-04 paths and commit once**

```bash
git add 'src/app/(app)/lists/[id]/wine-list-editor.tsx' 'src/app/(app)/lists/[id]/wine-list-editor.mobile.test.tsx' 'src/app/(app)/lists/[id]/components/template-picker.tsx' 'src/app/(app)/lists/[id]/components/template-picker.test.tsx' 'src/app/(app)/lists/[id]/page.tsx' 'src/app/(app)/lists/[id]/page.test.tsx' e2e/mobile-list-editor.test.ts
git commit -m "fix: make wine list editing survive mobile"
```
