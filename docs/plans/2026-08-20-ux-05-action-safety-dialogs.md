# Action Safety Dialogs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** Give the six selected destructive workflows one predictable, keyboard-safe confirmation contract without changing what their server actions do.

**Architecture:** Add one dependency-free `ActionDialog` primitive that owns dialog semantics, focus containment/restoration, safe Escape handling, and body scroll locking. A tiny exported tier policy makes the immediate/undo/confirm distinction executable; only confirm-tier actions render this primitive. Replace confirmation UI only for 86/restore, permanent list deletion, section deletion, unpublishing, member removal/invitation revocation, and scan discard.

**Tech Stack:** React 19 client components, TypeScript 5, Tailwind v4 project tokens, Vitest 4 with happy-dom, existing `useFocusTrap` hook, no new dependency.

**Spec:** [`docs/plans/2026-08-20-high-leverage-ux-portfolio-spec.md`](2026-08-20-high-leverage-ux-portfolio-spec.md), UX-05.

**Dependencies / order:** Implement after UX-03 and before UX-04, UX-07, and UX-06. Later moves reuse this primitive. Do not migrate archive, clone, wine-item removal, cellar-record deletion, or any action not named below.

## Global Constraints

- Preserve the light editorial hospitality identity and existing tokens from `DESIGN.md`.
- Do not add a component library or other dependency.
- Selected controls must be at least 44px and every icon-only control must have an accessible name.
- Do not change persistence, authorization, API payloads, or deletion semantics.
- Use the repository's existing `react-dom/client` + `act` Vitest harness; do not add `@testing-library`.
- Use one final commit for this move. Do not make interim commits.
- Do not commit until the implementation diff has an approving Grok 4.6 audit.

---

### Task 1: Define and prove the action-tier and dialog contracts

**Files:**
- Create: `src/components/action-dialog.tsx`
- Create: `src/components/action-dialog.test.tsx`
- Modify: `src/lib/hooks/use-focus-trap.ts` (add pause-without-restore semantics for nested dialogs)
- Create or extend: `src/lib/hooks/use-focus-trap.test.tsx`

**Interfaces:**
- Produces: `type ActionTier = "immediate" | "undo" | "confirm"`.
- Produces: `actionNeedsConfirmation(tier: ActionTier): boolean`, returning `true` only for `confirm`.
- Produces: `ActionDialog({ open, title, description, confirmLabel, cancelLabel = "Cancel", busy = false, tone = "danger", onConfirm, onClose, children })`. Do not expose an unused `initialFocus` prop: focus goes to the first focusable child, then Cancel when there is no child control.
- `onClose` is ignored for Escape, backdrop, and Cancel activation while `busy` is true. Cancel stays focusable so the trap retains at least one reachable control; Confirm is disabled while busy.
- `ActionDialog` passes a stable `onEscape` function to `useFocusTrap`; store the latest `onClose` and `busy` in refs updated every render. Typing in dialog children or toggling `busy` must not tear down the trap, restore trigger focus, or recapture `previouslyFocused`.
- `useFocusTrap` gains `paused?: boolean`. `enabled=false` ends the trap and restores its original trigger; `paused=true` temporarily removes keyboard handling/autofocus without restoring or discarding that original trigger. Resuming from pause reuses the same snapshot and never recaptures the child dialog's focus. Thus child close restores its nested trigger inside the parent; eventual parent close restores the outer page trigger.

- [ ] **Step 1: Write the failing tier-policy and accessibility tests**

```tsx
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import { ActionDialog, actionNeedsConfirmation } from "./action-dialog";

function button(root: ParentNode, name: string) {
  return [...root.querySelectorAll<HTMLButtonElement>("button")].find((node) => node.textContent?.trim() === name)!;
}
async function change(input: HTMLInputElement, value: string) {
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value); input.dispatchEvent(new Event("input", { bubbles: true })); });
}
function Harness() {
  const [open, setOpen] = useState(true); const [busy, setBusy] = useState(false); const [value, setValue] = useState("");
  return <><ActionDialog open={open} busy={busy} title="Delete section" description="Cannot be undone." confirmLabel="Delete section" onClose={() => setOpen(false)} onConfirm={() => setBusy(true)}><input aria-label="Draft" value={value} onChange={(event) => setValue(event.target.value)} /><button type="button" onClick={() => setBusy(true)}>Start</button></ActionDialog></>;
}
async function mountFromTrigger(element: React.ReactElement) {
  const trigger = document.createElement("button"); trigger.textContent = "Open"; document.body.append(trigger); trigger.focus();
  const container = document.createElement("div"); document.body.append(container); const root = createRoot(container); await act(async () => root.render(element));
  return { container, root, trigger };
}

it.each([
  ["immediate", false],
  ["undo", false],
  ["confirm", true],
] as const)("maps %s to the confirmation requirement", (tier, expected) => {
  expect(actionNeedsConfirmation(tier)).toBe(expected);
});

it("labels the modal, traps Tab, closes on Escape, restores focus, and locks scroll", async () => {
  const onClose = vi.fn();
  const trigger = document.createElement("button");
  document.body.append(trigger);
  trigger.focus();
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(<ActionDialog open title="Delete section" description="Cannot be undone." confirmLabel="Delete section" onConfirm={vi.fn()} onClose={onClose} />));
  const dialog = container.querySelector<HTMLElement>('[role="dialog"]')!;
  expect(dialog.getAttribute("aria-modal")).toBe("true");
  const descriptionId = dialog.getAttribute("aria-describedby")!;
  expect(document.getElementById(descriptionId)?.textContent).toBe("Cannot be undone.");
  expect(document.body.style.overflow).toBe("hidden");
  const controls = [...dialog.querySelectorAll<HTMLButtonElement>("button")];
  controls.at(-1)!.focus();
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true }));
  expect(document.activeElement).toBe(controls[0]);
  controls[0].focus();
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true }));
  expect(document.activeElement).toBe(controls.at(-1));
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  expect(onClose).toHaveBeenCalledOnce();
  await act(async () => root.render(<ActionDialog open={false} title="Delete section" description="Cannot be undone." confirmLabel="Delete section" onConfirm={vi.fn()} onClose={onClose} />));
  expect(document.activeElement).toBe(trigger);
  expect(document.body.style.overflow).toBe("");
  await act(async () => root.unmount());
});

it("keeps focus in the dialog across child typing and busy rerenders", async () => {
  const { container, root, trigger } = await mountFromTrigger(<Harness />);
  const input = container.querySelector<HTMLInputElement>("input")!;
  input.focus();
  await change(input, "Cabernet");
  expect(document.activeElement).toBe(input);
  expect(document.activeElement).not.toBe(trigger);
  await act(async () => button(container, "Start").click());
  const cancel = button(container, "Cancel");
  cancel.focus();
  expect(document.activeElement).toBe(cancel);
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true }));
  expect(document.activeElement).toBe(cancel);
  await act(async () => cancel.click());
  expect(container.querySelector('[role="dialog"]')).not.toBeNull();
  expect(document.activeElement).not.toBe(trigger);
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  expect(container.querySelector('[role="dialog"]')).not.toBeNull();
  await act(async () => root.unmount());
});
```

- [ ] **Step 2: Run the focused test to verify RED**

Run: `pnpm test -- src/components/action-dialog.test.tsx`

Expected: FAIL only because `action-dialog.tsx` and the hook's `paused` contract do not exist; the inline harness, mount, input-change, and button-query helpers compile and run.

- [ ] **Step 3: Implement the minimal primitive**

```tsx
export type ActionTier = "immediate" | "undo" | "confirm";
export const actionNeedsConfirmation = (tier: ActionTier) => tier === "confirm";

export function ActionDialog(props: ActionDialogProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(props.onClose);
  const busyRef = useRef(props.busy);
  onCloseRef.current = props.onClose;
  busyRef.current = props.busy;
  const onEscape = useCallback(() => {
    if (!busyRef.current) onCloseRef.current();
  }, []);
  const titleId = useId();
  const descriptionId = useId();
  useFocusTrap({
    containerRef: panelRef,
    enabled: props.open,
    onEscape,
  });
  useEffect(() => {
    if (!props.open) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = previous; };
  }, [props.open]);
  if (!props.open) return null;
  return (
    <div className="fixed inset-0 z-[60] flex items-end bg-ink/40 p-md sm:items-center" onMouseDown={handleSafeBackdrop}>
      <div ref={panelRef} role="dialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={descriptionId} className="w-full rounded-t-card bg-white p-lg sm:mx-auto sm:max-w-[420px] sm:rounded-card">
        <h2 id={titleId}>{props.title}</h2>
        <p id={descriptionId}>{props.description}</p>
        {props.children}
        <button type="button" className="min-h-11" aria-disabled={props.busy || undefined} onClick={() => { if (!busyRef.current) onCloseRef.current(); }}>{props.cancelLabel ?? "Cancel"}</button>
        <button type="button" className="min-h-11" onClick={props.onConfirm} disabled={props.busy}>{props.confirmLabel}</button>
      </div>
    </div>
  );
}
```

Use the project's actual design tokens and focus-visible styles. Keep the trap active on the panel, prevent accidental click-through by checking `event.target === event.currentTarget`, and add busy-state tests proving Escape/backdrop/Cancel do not close, Cancel stays tabbable, and focus never restores during a busy rerender. Add forward-Tab and Shift-Tab wrap assertions. Limit the 44px class gate to `ActionDialog`'s Cancel and Confirm controls; this move does not authorize resizing every trigger on the migrated pages.

- [ ] **Step 4: Run the primitive tests to verify GREEN**

Run: `pnpm test -- src/components/action-dialog.test.tsx src/lib/hooks/use-focus-trap.test.tsx`

Expected: PASS; the second path may be omitted when the hook is unchanged.

---

### Task 2: Migrate only the six selected confirm-tier workflows

**Files:**
- Modify: `src/app/(app)/cellar/note-modal.tsx` (`NoteModal` 86/restore confirmation)
- Modify: `src/app/(app)/cellar/wine-detail-drawer.tsx` (`useFocusTrap` paused condition while the nested 86 dialog is open)
- Modify: `src/app/(app)/lists/wine-list-landing.tsx` (`deleteList`; leave `toggleArchive` and `cloneList` unchanged)
- Modify: `src/app/(app)/lists/[id]/wine-list-editor.tsx` (`deleteTarget`; leave `wineToDelete` unchanged)
- Modify: `src/app/(app)/lists/[id]/components/publish-modal.tsx` (`unpublish`; add `listName` prop and disable its parent trap while confirming)
- Modify: `src/app/(app)/team/team-actions.tsx` (`removeMember` and `revokeInvitation` request state)
- Modify: `src/app/(app)/scan/views/results-view.tsx` (`onScanAnother` discard confirmation)
- Create: `src/app/(app)/lists/wine-list-landing.action-dialog.test.tsx`
- Create: `src/app/(app)/lists/[id]/wine-list-editor.action-dialog.test.tsx`
- Create: `src/app/(app)/lists/[id]/components/publish-modal.test.tsx`
- Create: `src/app/(app)/team/team-actions.action-dialog.test.tsx`
- Create: `src/app/(app)/scan/views/results-view.action-dialog.test.tsx`
- Create or extend: `src/app/(app)/cellar/note-modal.test.tsx`
- Create or extend: `src/app/(app)/cellar/wine-detail-drawer-state.test.tsx` (nested drawer/dialog trap ownership)

**Interfaces:**
- Each trigger stores the concrete target object or ID; confirmation calls the existing async handler exactly once.
- Dialog titles and confirm labels name the action: `86 wine`, `Restore wine`, `Permanently delete list`, `Delete section`, `Unpublish list`, `Remove member`, `Revoke invitation`, and `Discard scan`.
- Parent traps remain enabled but use `paused={childConfirmationOpen}` so two document-level traps never compete and pausing never restores/recaptures focus.
- `NoteModal` becomes content/state orchestration around `ActionDialog`; remove its backdrop, `role="dialog"`, heading chrome, scroll lock, focus trap, and textarea autofocus effect. Its confirm label is exactly `86 {wineName}` for `eightysixed` and `Restore {wineName}` for `restored`.
- Both `Clear` and `Scan another` in `ResultsView` open the same `Discard scan` confirmation and only invoke `onScanAnother` after confirmation.
- Each surface owns explicit `target`, `busy`, and close/reset state. Confirm uses the captured target, sets its existing busy field, and clears the target only after success or explicit Cancel; failures retain the target for retry and render through the surface's existing error field. Do not add new persistence or parallel error systems.
- Archived-list deletion keeps both existing descriptions verbatim: published archived lists warn that the public link stops immediately; unpublished archived lists warn that sections/items are removed. Tests use `archived: true` fixtures for both variants and prove non-archived targets never open the dialog.

- [ ] **Step 1: Write failing integration tests around the selected triggers**

```tsx
it("asks before discarding a scan and only clears after confirmation", async () => {
  const onScanAnother = vi.fn();
  const { container, root } = await mount(<ResultsView {...resultProps({ onScanAnother })} />);
  await act(async () => button(container, "Clear").click());
  expect(onScanAnother).not.toHaveBeenCalled();
  const dialog = container.querySelector<HTMLElement>('[role="dialog"]')!;
  expect(dialog.textContent).toContain("all edits will be lost");
  await act(async () => button(dialog, "Discard scan").click());
  expect(onScanAnother).toHaveBeenCalledOnce();
  await act(async () => root.unmount());
});

it.each(["Clear", "Scan another"])("routes %s through the shared discard confirmation", async (triggerLabel) => {
  const onScanAnother = vi.fn();
  const { container, root } = await mount(<ResultsView {...resultProps({ onScanAnother })} />);
  await act(async () => button(container, triggerLabel).click());
  expect(onScanAnother).not.toHaveBeenCalled();
  const dialog = [...container.querySelectorAll<HTMLElement>('[role="dialog"]')]
    .find((node) => node.querySelector("h2")?.textContent === "Discard scan")!;
  await act(async () => button(dialog, "Discard scan").click());
  expect(onScanAnother).toHaveBeenCalledOnce();
  await act(async () => root.unmount());
});

it("does not replace archive, clone, or wine-item removal with ActionDialog", () => {
  expect(source).toContain("window.confirm(confirmMessage)"); // archive and clone remain bounded out
  expect(editorSource).toContain("wineToDelete");             // existing wine-item dialog remains bounded out
});
```

For list deletion, section deletion, unpublish, member removal, invitation revocation, and both 86/Restore directions, assert the target/busy/clear lifecycle: Cancel sends no request and clears only the target, Confirm sends the pre-existing method/URL/body once, busy prevents duplicate submit/Cancel/Escape/backdrop, success clears, and failure keeps the target plus existing error for retry. Query the nested unpublish confirmation by its `Unpublish list` title rather than the parent Publish dialog's generic `[role="dialog"]`. For `NoteModal`, flush the focus frame and assert the note textarea—not Cancel—receives initial focus. Add a source-boundary assertion that the archive and clone handlers are untouched. In the drawer-state test, focus the nested 86 trigger, open the child, assert parent pause neither restores the outer trigger nor recaptures focus, and assert child Tab and Shift+Tab wrap only within its first/last controls. Close the child and assert focus restores to the nested 86 trigger; resume the parent and assert its Tab/Shift+Tab wrap; close the parent and assert focus restores to the original outer trigger.

- [ ] **Step 2: Run the selected integration tests to verify RED**

Run: `pnpm test -- 'src/app/(app)/cellar/note-modal.test.tsx' 'src/app/(app)/lists/wine-list-landing.action-dialog.test.tsx' 'src/app/(app)/lists/[id]/wine-list-editor.action-dialog.test.tsx' 'src/app/(app)/lists/[id]/components/publish-modal.test.tsx' 'src/app/(app)/team/team-actions.action-dialog.test.tsx' 'src/app/(app)/scan/views/results-view.action-dialog.test.tsx'`

Expected: FAIL because the selected surfaces still use native confirms or bespoke dialog markup.

- [ ] **Step 3: Replace each selected confirmation with `ActionDialog`**

```tsx
const [pendingMemberRemoval, setPendingMemberRemoval] = useState<Member | null>(null);

<ActionDialog
  open={pendingMemberRemoval !== null}
  title="Remove member"
  description={`${pendingMemberRemoval?.name ?? "This member"} will lose access to this restaurant.`}
  confirmLabel="Remove member"
  busy={memberActionBusy}
  onClose={() => setPendingMemberRemoval(null)}
  onConfirm={() => pendingMemberRemoval && removeMember(pendingMemberRemoval.id)}
/>
```

Apply the same explicit target-state pattern to the other named actions. Keep all existing fetch URLs, HTTP methods, error messages, optimistic state, and `router.refresh()` calls. Pass `list.name` into `PublishModal` for an action-specific unpublish description. Render the 86 optional note as `ActionDialog` children and preserve its existing audit-note payload; `NoteModal` must not retain its own modal chrome or trap. Pause parent traps with `paused={childConfirmationOpen}` rather than setting `enabled=false`. Route both `Clear` and `Scan another` through one `discardOpen` state and one confirm callback.

- [ ] **Step 4: Run focused and affected tests**

Run: `pnpm test -- src/components/action-dialog.test.tsx 'src/app/(app)/cellar/note-modal.test.tsx' 'src/app/(app)/cellar/wine-detail-drawer-state.test.tsx' 'src/app/(app)/lists/wine-list-landing.action-dialog.test.tsx' 'src/app/(app)/lists/[id]/wine-list-editor.action-dialog.test.tsx' 'src/app/(app)/lists/[id]/components/publish-modal.test.tsx' 'src/app/(app)/team/team-actions.action-dialog.test.tsx' 'src/app/(app)/scan/views/results-view.action-dialog.test.tsx'`

Expected: PASS with no native-confirm assertion for any selected action and boundary tests proving excluded actions remain excluded.

---

### Task 3: Verify, audit, and create the single move commit

**Files:** All files listed in Tasks 1–2 and no others.

- [ ] **Step 1: Run move verification**

```bash
pnpm test -- src/components/action-dialog.test.tsx 'src/app/(app)/cellar/note-modal.test.tsx' 'src/app/(app)/cellar/wine-detail-drawer-state.test.tsx' 'src/app/(app)/lists/wine-list-landing.action-dialog.test.tsx' 'src/app/(app)/lists/[id]/wine-list-editor.action-dialog.test.tsx' 'src/app/(app)/lists/[id]/components/publish-modal.test.tsx' 'src/app/(app)/team/team-actions.action-dialog.test.tsx' 'src/app/(app)/scan/views/results-view.action-dialog.test.tsx'
pnpm exec tsc --noEmit
pnpm lint
git diff --check
```

Expected: all commands exit 0.

- [ ] **Step 2: Perform the independent task review**

Review the diff against UX-05 and reject any migration beyond the six selected workflows, any API behavior change, any missing action-specific label, sub-44px ActionDialog control, or any nested simultaneous focus trap. Re-render a dialog while typing and while busy; focus must stay inside until the real close.

- [ ] **Step 3: Obtain the mandatory Grok 4.6 pre-commit audit**

Send the UX-05 plan plus the complete unstaged diff to `x-ai/grok-4.6`. Require an `APPROVE` or `REVISE` verdict covering scope, dialog semantics, focus containment/restoration, scroll restoration, busy Escape behavior, selected-only migration, and test strength. Resolve every blocking or important finding, rerun Step 1, and re-audit until `APPROVE`.

- [ ] **Step 4: Stage only the exact UX-05 paths and commit once**

```bash
git add src/components/action-dialog.tsx src/components/action-dialog.test.tsx src/lib/hooks/use-focus-trap.ts src/lib/hooks/use-focus-trap.test.tsx 'src/app/(app)/cellar/note-modal.tsx' 'src/app/(app)/cellar/note-modal.test.tsx' 'src/app/(app)/cellar/wine-detail-drawer.tsx' 'src/app/(app)/cellar/wine-detail-drawer-state.test.tsx' 'src/app/(app)/lists/wine-list-landing.tsx' 'src/app/(app)/lists/wine-list-landing.action-dialog.test.tsx' 'src/app/(app)/lists/[id]/wine-list-editor.tsx' 'src/app/(app)/lists/[id]/wine-list-editor.action-dialog.test.tsx' 'src/app/(app)/lists/[id]/components/publish-modal.tsx' 'src/app/(app)/lists/[id]/components/publish-modal.test.tsx' 'src/app/(app)/team/team-actions.tsx' 'src/app/(app)/team/team-actions.action-dialog.test.tsx' 'src/app/(app)/scan/views/results-view.tsx' 'src/app/(app)/scan/views/results-view.action-dialog.test.tsx'
git commit -m "feat: standardize destructive action dialogs"
```

If `use-focus-trap` files were not changed or a listed test was folded into an existing test file, omit the nonexistent/unchanged path from `git add`; do not stage anything outside this plan.
