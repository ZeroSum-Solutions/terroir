# Floor Forms and Targets Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** Make invoice correction, pour, and 86 controls touch-safe and programmatically labelled while preserving invalid operator drafts until correction or cancellation.

**Architecture:** Add two small local primitives: `Field` connects visible labels, descriptions, and errors to a render-prop input contract; `IconButton` enforces an accessible name and 44px floor. Adopt them only on invoice correction, pour, and 86 surfaces. Keep each flow's current validation rules and request payloads, but represent a parse failure as local draft/error state instead of coercing or discarding what the operator typed.

**Tech Stack:** React 19, TypeScript 5, Tailwind v4, existing UX-05 `ActionDialog`, Vitest 4 with happy-dom, no new dependency.

**Spec:** [`docs/plans/2026-08-20-high-leverage-ux-portfolio-spec.md`](2026-08-20-high-leverage-ux-portfolio-spec.md), UX-07.

**Dependencies / order:** Execute after UX-04 and UX-05. The 86 dialog reuses `ActionDialog`; do not introduce another modal. No new validation rule is authorized.

## Global Constraints

- Migrate only invoice correction, pour, and 86 controls.
- Every migrated input must have a visible programmatic label and link description/error text with `aria-describedby`.
- Invalid migrated inputs set `aria-invalid="true"` and retain the exact draft until correction or explicit cancellation.
- Every migrated button and icon button must meet the 44px floor; icon-only controls require an accessible name.
- Every migrated text/select/number/textarea control must also have a `min-h-11` floor. Remove the `md:h-9 md:w-9` shrink from `QtyStepper`; both quantity buttons stay 44px at every breakpoint.
- Preserve existing request URLs, request bodies, numeric bounds, validation meaning, and server behavior.
- Use `renderToStaticMarkup` or the existing `react-dom/client` + `act` Vitest harness; do not add a test utility dependency.
- Use one final commit for this move. Do not make interim commits.
- Do not commit until the implementation diff has an approving Grok 4.6 audit.

---

### Task 1: Build the local Field and IconButton primitives

**Files:**
- Create: `src/components/field.tsx`
- Create: `src/components/field.test.tsx`
- Create: `src/components/icon-button.tsx`
- Create: `src/components/icon-button.test.tsx`

**Interfaces:**
- Produces: `Field({ id, label, description, error, required, srOnlyLabel = false, children })`, where `children` receives `{ id, "aria-describedby": string | undefined, "aria-invalid": true | undefined, "aria-required": true | undefined }`. `srOnlyLabel` applies the project's `sr-only` class only to the `<label>` for desktop table cells.
- Produces: `IconButton` extending native button props with required `label: string`, rendered as `aria-label={label}` and `min-h-11 min-w-11`.
- Field description ID is `${id}-description`; error ID is `${id}-error`; both IDs appear in `aria-describedby` when both exist.

- [ ] **Step 1: Write failing semantic tests**

```tsx
it("connects label, description, and error to the input", () => {
  document.body.innerHTML = renderToStaticMarkup(
    <Field id="unit-cost" label="Unit cost" description="Per bottle" error="Enter a number">
      {(a11y) => <input {...a11y} />}
    </Field>,
  );
  const input = document.querySelector<HTMLInputElement>("#unit-cost")!;
  expect(document.querySelector('label[for="unit-cost"]')?.textContent).toBe("Unit cost");
  expect(input.getAttribute("aria-label")).toBeNull();
  expect(input.getAttribute("aria-invalid")).toBe("true");
  expect(input.getAttribute("aria-describedby")).toBe("unit-cost-description unit-cost-error");
});

it("requires an accessible label and applies the target floor", () => {
  document.body.innerHTML = renderToStaticMarkup(<IconButton label="Remove Cabernet"><Trash2 /></IconButton>);
  const button = document.querySelector<HTMLButtonElement>('button[aria-label="Remove Cabernet"]')!;
  expect(button.className).toContain("min-h-11");
  expect(button.className).toContain("min-w-11");
});

it("can visually hide only the label when a visible table header already names the column", () => {
  document.body.innerHTML = renderToStaticMarkup(<Field id="desktop-vintage" label="Vintage" srOnlyLabel>{(a11y) => <input {...a11y} />}</Field>);
  const label = document.querySelector('label[for="desktop-vintage"]')!;
  expect(label.className).toContain("sr-only");
  expect(document.querySelector<HTMLInputElement>("#desktop-vintage")).not.toBeNull();
});
```

- [ ] **Step 2: Run primitive tests to verify RED**

Run: `pnpm test -- src/components/field.test.tsx src/components/icon-button.test.tsx`

Expected: FAIL because both modules are absent.

- [ ] **Step 3: Implement minimal typed primitives**

```tsx
export function Field({ id, label, description, error, srOnlyLabel = false, children }: FieldProps) {
  const describedBy = [description && `${id}-description`, error && `${id}-error`].filter(Boolean).join(" ") || undefined;
  return (
    <div>
      <label htmlFor={id} className={srOnlyLabel ? "sr-only" : undefined}>{label}</label>
      {description && <p id={`${id}-description`}>{description}</p>}
      {children({ id, "aria-describedby": describedBy, "aria-invalid": error ? true : undefined })}
      {error && <p id={`${id}-error`} role="alert">{error}</p>}
    </div>
  );
}

export function IconButton({ label, className, children, ...button }: IconButtonProps) {
  return <button {...button} aria-label={label} className={cn("inline-flex min-h-11 min-w-11 items-center justify-center", className)}>{children}</button>;
}
```

Use project typography, borders, and focus tokens. Keep the primitives presentation-light; they must not own business validation.

- [ ] **Step 4: Run primitive tests to verify GREEN**

Run: `pnpm test -- src/components/field.test.tsx src/components/icon-button.test.tsx`

Expected: PASS.

---

### Task 2: Preserve invoice-correction drafts and link their errors

**Files:**
- Modify: `src/app/(app)/scan/components/field-inputs.tsx` (`FieldWrap`, `TextInput`, `VintageInput`, `MoneyInput`, `QtyStepper`)
- Modify: `src/app/(app)/scan/components/line-item-card.tsx` (`MobileField`, remove control)
- Modify: `src/app/(app)/scan/views/results-view.tsx` (source fields, desktop correction inputs, selected buttons)
- Create: `src/app/(app)/scan/components/field-inputs.test.tsx`
- Create: `src/app/(app)/scan/components/line-item-card.test.tsx`
- Create or extend: `src/app/(app)/scan/views/results-view.fields.test.tsx`

**Interfaces:**
- `TextInput` requires `id` and `label`; `VintageInput` and `MoneyInput` require stable `id` and visible label supplied by `Field`/`MobileField`.
- Existing vintage rule remains byte-for-byte in meaning: blank or `NV` commits `null`; otherwise `parseInt(trimmed, 10)` commits when finite. Text that makes that existing parse non-finite stays in the input and shows `Enter a year or NV.` without calling `onCommit`.
- Existing money rule remains byte-for-byte in meaning: `parseFloat(draft.replace(/,/g, ""))` commits when finite. Text that makes that existing parse non-finite stays and shows `Enter a valid amount.` without calling `onCommit`.
- Correcting the draft clears the linked error and commits normally.
- `MobileField` stops rendering its own `<dt>` label; the nested `Field` is the one visible, programmatic label on mobile. In the desktop table, retain the existing visible `<Th>` column labels and render the per-row `Field` label with an `sr-only` label class so visual labels are not duplicated while `label[for]` still owns the input.
- Source Supplier, Invoice number, and Delivery date fields each receive stable IDs, `Field` labels, `min-h-11`, and linked error state if their existing validation can fail. Do not use a duplicate `aria-label` as the test oracle.

- [ ] **Step 1: Write failing draft-preservation and accessible-error tests**

```tsx
it("keeps an invalid vintage draft until the operator corrects it", async () => {
  const onCommit = vi.fn();
  const { container, root } = await mount(<VintageInput id="line-1-vintage" label="Vintage" value={2022} onCommit={onCommit} />);
  const input = container.querySelector<HTMLInputElement>("#line-1-vintage")!;
  await change(input, "twenty-two");
  await act(async () => input.dispatchEvent(new FocusEvent("blur", { bubbles: true })));
  expect(input.value).toBe("twenty-two");
  expect(input.getAttribute("aria-invalid")).toBe("true");
  expect(document.getElementById("line-1-vintage-error")?.textContent).toBe("Enter a year or NV.");
  expect(onCommit).not.toHaveBeenCalled();
  await act(async () => root.unmount());
});

it("retains invalid unit-cost text and keeps the remove target touch sized", async () => {
  const { container, root } = await mount(<LineItemCard {...props()} />);
  const cost = container.querySelector<HTMLInputElement>("#line-line-1-unit-cost")!;
  expect(container.querySelector('label[for="line-line-1-unit-cost"]')?.textContent).toBe("Unit cost");
  await change(cost, "abc");
  await act(async () => cost.dispatchEvent(new FocusEvent("blur", { bubbles: true })));
  expect(cost.value).toBe("abc");
  expect(cost.getAttribute("aria-invalid")).toBe("true");
  expect(cost.getAttribute("aria-describedby")).toContain("line-line-1-unit-cost-error");
  const remove = container.querySelector<HTMLButtonElement>('button[aria-label^="Remove"]')!;
  expect(remove.className).toContain("min-h-11");
  expect(remove.className).toContain("min-w-11");
  await act(async () => root.unmount());
});

it("clears the linked money error after a valid correction", async () => {
  const onCommit = vi.fn();
  const { container, root } = await mount(<MoneyInput id="line-1-unit-cost" label="Unit cost" value={12} onCommit={onCommit} />);
  const input = container.querySelector<HTMLInputElement>("#line-1-unit-cost")!;
  await change(input, "abc");
  await blur(input);
  expect(input.getAttribute("aria-invalid")).toBe("true");
  await change(input, "14.25");
  await blur(input);
  expect(input.getAttribute("aria-invalid")).toBeNull();
  expect(container.querySelector("#line-1-unit-cost-error")).toBeNull();
  expect(onCommit).toHaveBeenCalledWith(14.25);
  await act(async () => root.unmount());
});

it("labels source fields by for/id and keeps inputs and quantity controls touch sized", async () => {
  const { container, root } = await mount(<ResultsView {...resultProps()} />);
  for (const [id, label] of [["scan-supplier", "Supplier"], ["scan-invoice-number", "Invoice number"], ["scan-delivery-date", "Delivery date"]]) {
    const input = container.querySelector<HTMLInputElement>(`#${id}`)!;
    expect(container.querySelector(`label[for="${id}"]`)?.textContent).toBe(label);
    expect(input.getAttribute("aria-label")).toBeNull();
    expect(input.className).toContain("min-h-11");
  }
  for (const input of container.querySelectorAll<HTMLInputElement>('[id^="line-"]')) {
    expect(container.querySelector(`label[for="${input.id}"]`)).not.toBeNull();
    expect(input.getAttribute("aria-label")).toBeNull();
    expect(input.className).toContain("min-h-11");
  }
  for (const stepper of container.querySelectorAll<HTMLButtonElement>('[aria-label="Decrease quantity"], [aria-label="Increase quantity"]')) {
    expect(stepper.className).toContain("h-11");
    expect(stepper.className).not.toContain("md:h-9");
  }
  await act(async () => root.unmount());
});
```

- [ ] **Step 2: Run invoice field tests to verify RED**

Run: `pnpm test -- 'src/app/(app)/scan/components/field-inputs.test.tsx' 'src/app/(app)/scan/components/line-item-card.test.tsx' 'src/app/(app)/scan/views/results-view.fields.test.tsx'`

Expected: FAIL because errors are not rendered/linked, several labels are only visual table context, and selected desktop targets are below 44px.

- [ ] **Step 3: Adopt `Field` and `IconButton` without adding validation**

```tsx
const [error, setError] = useState<string | null>(null);
const commitVintage = () => {
  const trimmed = draft.trim().toUpperCase();
  if (!trimmed || trimmed === "NV") { setError(null); onCommit(null); return; }
  const parsed = parseInt(trimmed, 10);
  if (!Number.isFinite(parsed)) { setError("Enter a year or NV."); return; }
  setError(null);
  onCommit(parsed);
};

<Field id={id} label={label} error={error}>
  {(a11y) => <input {...a11y} value={draft} onChange={handleDraft} onBlur={commitVintage} />}
</Field>
```

Use unique IDs built from line item ID plus field name in mobile cards and table rows. Replace `MobileField`'s standalone label with `Field` so mobile gets one visible label, and keep the desktop `<Th>` as the sole visible column heading while the row-level `Field` label is `sr-only`. Wrap source Supplier, Invoice number, and Delivery date in `Field`, add `min-h-11` to all migrated inputs/actions, and keep both `QtyStepper` controls `h-11 w-11` at every breakpoint. Replace only icon buttons in the named invoice correction flow with `IconButton`. Add explicit invalid→valid error-clearing tests for Vintage and Money plus `for`/`id`/`aria-invalid`/`aria-describedby` assertions; do not query duplicate `aria-label` text. Do not reject negative, out-of-range, empty, or unusual values unless the existing code already rejects them.

- [ ] **Step 4: Run invoice field tests to verify GREEN**

Run: `pnpm test -- 'src/app/(app)/scan/components/field-inputs.test.tsx' 'src/app/(app)/scan/components/line-item-card.test.tsx' 'src/app/(app)/scan/views/results-view.fields.test.tsx'`

Expected: PASS, with exact draft retention and no new validation boundary.

---

### Task 3: Migrate pour and 86 controls

**Files:**
- Modify: `src/app/(app)/cellar/pour-picker-modal.tsx` (`customValue`, local error, note field, controls)
- Modify: `src/app/(app)/cellar/note-modal.tsx` (86 note `Field`, UX-05 dialog controls)
- Create: `src/app/(app)/cellar/pour-picker-modal.test.tsx`
- Extend: `src/app/(app)/cellar/note-modal.test.tsx`

**Interfaces:**
- Existing custom-pour rule remains `Number.isFinite(oz) && oz > 0`; invalid text stays visible with `Enter a pour greater than 0 oz.` and no confirmation callback.
- Pour and 86 optional notes remain local controlled drafts with the existing 500-character maximum. Invalid custom-pour submission retains both custom and note drafts; explicit Cancel may clear them through the existing cancel behavior. Do not change `doPour`, `/api/pour`, or any note payload contract.

- [ ] **Step 1: Write failing pour and 86 tests**

```tsx
it("keeps an invalid custom pour editable and links the existing rule", async () => {
  const onConfirm = vi.fn();
  const { container, root } = await mount(<PourPickerModal item={bottle} onCancel={vi.fn()} onConfirm={onConfirm} />);
  const input = container.querySelector<HTMLInputElement>("#pour-picker-custom")!;
  expect(container.querySelector('label[for="pour-picker-custom"]')?.textContent).toBe("Custom (oz)");
  expect(input.getAttribute("aria-label")).toBeNull();
  await change(input, "0");
  await act(async () => button(container, "Pour").click());
  expect(input.value).toBe("0");
  expect(input.getAttribute("aria-invalid")).toBe("true");
  expect(onConfirm).not.toHaveBeenCalled();
  await act(async () => root.unmount());
});

it("retains local pour drafts after invalid submit and clears them on explicit Cancel", async () => {
  const onCancel = vi.fn();
  const { container, root } = await mount(<PourPickerModal item={bottle} onCancel={onCancel} onConfirm={vi.fn()} />);
  const custom = container.querySelector<HTMLInputElement>("#pour-picker-custom")!;
  const note = container.querySelector<HTMLTextAreaElement>("#pour-picker-note")!;
  await change(custom, "0");
  await change(note, "VIP comp");
  await act(async () => button(container, "Pour").click());
  expect(custom.value).toBe("0");
  expect(note.value).toBe("VIP comp");
  await act(async () => button(container, "Cancel").click());
  expect(onCancel).toHaveBeenCalledOnce();
  await act(async () => root.unmount());
});

it("keeps 86 note and action controls labelled and touch sized", () => {
  document.body.innerHTML = renderToStaticMarkup(<NoteModal open wineName="Cabernet" direction="eightysixed" onCancel={vi.fn()} onConfirm={vi.fn()} />);
  expect(document.querySelector('label[for="eightysix-note"]')?.textContent).toBe("Note (optional)");
  expect(document.querySelector<HTMLTextAreaElement>("#eightysix-note")?.getAttribute("maxlength")).toBe("500");
  const action = [...document.querySelectorAll<HTMLButtonElement>("button")].find((node) => node.textContent?.trim() === "86 Cabernet")!;
  expect(action.className).toContain("min-h-11");
});

it.each([
  ["eightysixed", "86 Cabernet"],
  ["restored", "Restore Cabernet"],
] as const)("uses the action-specific %s confirmation label", (direction, confirmLabel) => {
  document.body.innerHTML = renderToStaticMarkup(<NoteModal open wineName="Cabernet" direction={direction} onCancel={vi.fn()} onConfirm={vi.fn()} />);
  expect([...document.querySelectorAll("button")].some((node) => node.textContent?.trim() === confirmLabel)).toBe(true);
});

it("keeps the invalid pour submit reachable so it can reveal the linked error", async () => {
  const { container, root } = await mount(<PourPickerModal item={bottle} onCancel={vi.fn()} onConfirm={vi.fn()} />);
  const input = container.querySelector<HTMLInputElement>("#pour-picker-custom")!;
  await change(input, "0");
  const submit = button(container, "Pour");
  expect(submit.disabled).toBe(false);
  expect(submit.className).toContain("min-h-11");
  await act(async () => submit.click());
  expect(input.getAttribute("aria-invalid")).toBe("true");
  expect(input.getAttribute("aria-describedby")).toContain("pour-picker-custom-error");
  await change(input, "5");
  expect(input.getAttribute("aria-invalid")).toBeNull();
  await act(async () => root.unmount());
});

it("keeps every migrated pour and 86 input and action touch sized without duplicate aria labels", async () => {
  const { container, root } = await mount(<PourPickerModal item={bottle} onCancel={vi.fn()} onConfirm={vi.fn()} />);
  for (const id of ["pour-picker-custom", "pour-picker-note"]) {
    const control = container.querySelector<HTMLElement>(`#${id}`)!;
    expect(container.querySelector(`label[for="${id}"]`)).not.toBeNull();
    expect(control.getAttribute("aria-label")).toBeNull();
    expect(control.className).toContain("min-h-11");
  }
  for (const name of ["1 oz", "3 oz", "5 oz", "8 oz", "Pour", "Cancel"]) expect(button(container, name).className).toContain("min-h-11");
  await act(async () => root.unmount());

  for (const [direction, confirmLabel] of [["eightysixed", "86 Cabernet"], ["restored", "Restore Cabernet"]] as const) {
    document.body.innerHTML = renderToStaticMarkup(<NoteModal open wineName="Cabernet" direction={direction} onCancel={vi.fn()} onConfirm={vi.fn()} />);
    const note = document.querySelector<HTMLTextAreaElement>("#eightysix-note")!;
    expect(document.querySelector('label[for="eightysix-note"]')).not.toBeNull();
    expect(note.getAttribute("aria-label")).toBeNull();
    expect(note.className).toContain("min-h-11");
    for (const name of ["Cancel", confirmLabel]) expect(button(document, name).className).toContain("min-h-11");
  }
});

```

- [ ] **Step 2: Run pour/86 tests to verify RED**

Run: `pnpm test -- 'src/app/(app)/cellar/pour-picker-modal.test.tsx' 'src/app/(app)/cellar/note-modal.test.tsx'`

Expected: FAIL because custom-pour error semantics are missing, invalid submit is unreachable while disabled, local draft/error semantics are absent, and selected controls are below the floor.

- [ ] **Step 3: Implement minimal accessible behavior**

```tsx
const [customError, setCustomError] = useState<string | null>(null);
const submitCustom = () => {
  const oz = Number(customValue);
  if (!Number.isFinite(oz) || oz <= 0) {
    setCustomError("Enter a pour greater than 0 oz.");
    return;
  }
  setCustomError(null);
  handleConfirm(Math.max(1, Math.round(oz * ML_PER_OZ)));
};

```

Render custom pour and both note fields through `Field`; label them through `label[for]` and stable IDs, not redundant `aria-label` attributes. Keep the custom submit enabled for invalid nonempty drafts so activation can set the linked error without clearing either local draft, and clear that error on the next valid change/submit. Explicit Cancel may clear drafts through the existing handlers. Ensure custom input, note textareas, preset, submit, Cancel, 86, Restore, and custom-picker actions are at least 44px. Preserve the UX-05 nested-trap behavior. Do not change `WineDetailDrawer`, `doPour`, `/api/pour`, payloads, or button wording.

- [ ] **Step 4: Run pour/86 tests to verify GREEN**

Run: `pnpm test -- 'src/app/(app)/cellar/pour-picker-modal.test.tsx' 'src/app/(app)/cellar/note-modal.test.tsx'`

Expected: PASS.

---

### Task 4: Verify, audit, and create the single move commit

**Files:** All files listed above and no others.

- [ ] **Step 1: Run move verification**

```bash
pnpm test -- src/components/field.test.tsx src/components/icon-button.test.tsx 'src/app/(app)/scan/components/field-inputs.test.tsx' 'src/app/(app)/scan/components/line-item-card.test.tsx' 'src/app/(app)/scan/views/results-view.fields.test.tsx' 'src/app/(app)/cellar/pour-picker-modal.test.tsx' 'src/app/(app)/cellar/note-modal.test.tsx'
pnpm exec tsc --noEmit
pnpm lint
git diff --check
```

Expected: all commands exit 0.

- [ ] **Step 2: Perform the independent task review**

Keyboard-test invalid invoice vintage/cost and custom pour, confirming exact local draft text remains, submit stays reachable, errors link and clear after correction, and explicit Cancel follows existing draft-clearing behavior. Check migrated inputs/actions and both QtyStepper buttons remain at least 44px at desktop and mobile, and no form outside invoice correction/pour/86 changed. Reject any `WineDetailDrawer`, `doPour`, API, payload, validation-rule, or unauthorized copy change.

- [ ] **Step 3: Obtain the mandatory Grok 4.6 pre-commit audit**

Send this plan and the complete UX-07 diff to `x-ai/grok-4.6`. Require `APPROVE` or `REVISE` covering labels/descriptions/errors, `aria-invalid`, local draft preservation/cancellation, target size, scope, unchanged validation/payloads, and tests. Resolve all blocking or important findings, rerun verification, and re-audit until `APPROVE`.

- [ ] **Step 4: Stage only the exact UX-07 paths and commit once**

```bash
git add src/components/field.tsx src/components/field.test.tsx src/components/icon-button.tsx src/components/icon-button.test.tsx 'src/app/(app)/scan/components/field-inputs.tsx' 'src/app/(app)/scan/components/field-inputs.test.tsx' 'src/app/(app)/scan/components/line-item-card.tsx' 'src/app/(app)/scan/components/line-item-card.test.tsx' 'src/app/(app)/scan/views/results-view.tsx' 'src/app/(app)/scan/views/results-view.fields.test.tsx' 'src/app/(app)/cellar/pour-picker-modal.tsx' 'src/app/(app)/cellar/pour-picker-modal.test.tsx' 'src/app/(app)/cellar/note-modal.tsx' 'src/app/(app)/cellar/note-modal.test.tsx'
git commit -m "fix: preserve accessible floor form drafts"
```
