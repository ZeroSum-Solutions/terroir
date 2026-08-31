import { expect, type Page } from "@playwright/test";

/**
 * GLOBAL-01, measured in the frame.
 *
 * Devin's rule, verbatim: "If you cannot fit all the buttons horizontally in
 * one frame, then there are too many buttons."
 *
 * Two gates already existed and neither asked that question.
 * `scripts/check-control-rows.mjs` counts ROWS in source;
 * `e2e/cellar-control-row.test.ts` asserted that exactly one row RENDERS in a
 * frame. Both passed while /cellar showed 3 of its 10 controls at 390px and
 * hid the other 7 behind 740px of sideways scroll inside the row — because a
 * row that scrolls is still one row, and a page whose overflow is contained
 * inside an `overflow-x-auto` child still reports
 * `documentElement.scrollWidth === innerWidth`.
 *
 * This module measures the thing the rule is actually about: every control in
 * the row, against `window.innerWidth`, via `getBoundingClientRect()`.
 */

export type ControlBox = {
  label: string;
  left: number;
  right: number;
  top: number;
  bottom: number;
  width: number;
  height: number;
};

export type RowFit = {
  /** Controls whose box overlaps the viewport rect at all. */
  controls: ControlBox[];
  /** The subset fully inside [0, innerWidth]. */
  inFrame: ControlBox[];
  /** The subset clipped by, or entirely outside, the viewport. */
  clipped: ControlBox[];
  /**
   * Visual lines the controls occupy. A `flex-wrap` row that spills onto a
   * second line is ONE element and one source row — and two rows to the eye,
   * which is the count the rule is written about.
   */
  lines: number;
  /** Sideways overflow of the row's own scroll container(s), in px. */
  overflowPx: number;
  /** Elements inside the row that can be scrolled sideways. */
  scrollers: Array<{ label: string; overflow: number }>;
  innerWidth: number;
};

/**
 * Interactive controls, leaf-most first. `[role="tab"]` is on the counter
 * buttons; `a[href]` catches the link-shaped actions. The search field is
 * GLOBAL-02-exempt from the COUNT, not from having to be on screen, so it is
 * measured like everything else.
 */
const CONTROL_SELECTOR = 'button, a[href], select, input, [role="tab"]';

type EvalArgs = { rowSelector: string; controlSelector: string };

/**
 * Measures one control row in the frame.
 *
 * @param rowSelector matches the row container(s); the first one currently
 *   intersecting the viewport is measured, so a page with a hero row and a
 *   sticky masthead is judged on whichever one the eye can see.
 */
export async function measureRowFit(page: Page, rowSelector: string): Promise<RowFit> {
  return page.evaluate(({ rowSelector: selector, controlSelector }: EvalArgs) => {
    const visible = (el: Element) => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    };
    const row = Array.from(document.querySelectorAll(selector)).find((el) => {
      if (!visible(el)) return false;
      const r = el.getBoundingClientRect();
      return r.bottom > 0 && r.top < window.innerHeight;
    });
    if (!row) {
      return {
        controls: [],
        inFrame: [],
        clipped: [],
        lines: 0,
        overflowPx: 0,
        scrollers: [],
        innerWidth: window.innerWidth,
      };
    }

    const name = (el: Element) =>
      (
        el.getAttribute("aria-label") ??
        el.textContent?.replace(/\s+/g, " ").trim() ??
        el.tagName.toLowerCase()
      ).slice(0, 40) || el.tagName.toLowerCase();

    const controls = Array.from(row.querySelectorAll(controlSelector))
      .filter(visible)
      .map((el) => {
        const r = el.getBoundingClientRect();
        return {
          label: name(el),
          left: Math.round(r.left),
          right: Math.round(r.right),
          top: Math.round(r.top),
          bottom: Math.round(r.bottom),
          width: Math.round(r.width),
          height: Math.round(r.height),
        };
      });

    // Only elements that CAN scroll sideways count as overflow. A `truncate`
    // paragraph also has scrollWidth > clientWidth and is not a defect.
    const scrollers: Array<{ label: string; overflow: number }> = [];
    for (const el of [row, ...Array.from(row.querySelectorAll("*"))]) {
      const overflowX = getComputedStyle(el).overflowX;
      if (overflowX !== "auto" && overflowX !== "scroll") continue;
      const overflow = el.scrollWidth - el.clientWidth;
      if (overflow > 1) scrollers.push({ label: name(el), overflow });
    }

    // Two controls are on the same visual line when their vertical extents
    // overlap; a wrapped control starts below the line it left.
    let lines = 0;
    let lineBottom = -Infinity;
    for (const c of [...controls].sort((a, b) => a.top - b.top)) {
      if (c.top >= lineBottom - 1) {
        lines += 1;
        lineBottom = c.bottom;
      } else {
        lineBottom = Math.max(lineBottom, c.bottom);
      }
    }

    return {
      controls,
      lines,
      inFrame: controls.filter((c) => c.left >= -1 && c.right <= window.innerWidth + 1),
      clipped: controls.filter((c) => c.left < -1 || c.right > window.innerWidth + 1),
      overflowPx: scrollers.reduce((max, s) => Math.max(max, s.overflow), 0),
      scrollers,
      innerWidth: window.innerWidth,
    };
  }, { rowSelector, controlSelector: CONTROL_SELECTOR });
}

const describeBoxes = (boxes: ControlBox[]) =>
  boxes
    .map((c) => `${c.label} x=[${c.left}…${c.right}] y=${c.top} w=${c.width}`)
    .join("\n    ");

/**
 * Asserts Devin's rule on one row: every control fully inside the viewport,
 * and nothing hidden behind a sideways scroll.
 */
export function expectRowFitsInFrame(fit: RowFit, where: string): void {
  expect(
    fit.controls.length,
    `${where}: no controls found — the selector matched nothing in frame`,
  ).toBeGreaterThan(0);

  expect(
    fit.clipped.map((c) => c.label),
    `${where}: ${fit.clipped.length} of ${fit.controls.length} controls are outside ` +
      `the ${fit.innerWidth}px frame.\n  clipped:\n    ${describeBoxes(fit.clipped)}\n` +
      `  in frame:\n    ${describeBoxes(fit.inFrame)}\n` +
      `"If you cannot fit all the buttons horizontally in one frame, then there are ` +
      `too many buttons."`,
  ).toEqual([]);

  expect(
    fit.scrollers,
    `${where}: the row scrolls sideways by ${fit.overflowPx}px, which hides controls ` +
      `rather than removing them.`,
  ).toEqual([]);

  expect(
    fit.lines,
    `${where}: ${fit.controls.length} controls wrap onto ${fit.lines} visual lines. ` +
      `A wrapping row is one element and one source row, and two rows to the eye — ` +
      `which is the count the rule is written about.\n    ${describeBoxes(fit.controls)}`,
  ).toBe(1);

  // Printed, not swallowed: this gate exists because nobody had the number.
  console.log(
    `[one-row] ${where}: ${fit.controls.length} controls, all in frame, 1 line, ` +
      `0px sideways overflow — ` +
      fit.controls.map((c) => `${c.label} ${c.width}px`).join(", "),
  );
}

/** DESIGN.md's floor, and the one every `min-h-11` in this repo encodes. */
export const TOUCH_TARGET_MIN_PX = 44;

/**
 * The other thing a row of controls has to be, on a phone: tappable.
 *
 * Fitting in the frame and being reachable by a thumb are separate failures —
 * `/lists/[id]/print` fitted its two controls on one line at 390px while
 * painting them 36px and 21px tall. Measured from the same `RowFit`, so a
 * surface pays for one `measureRowFit` call and gets both answers.
 */
export function expectTouchTargets(fit: RowFit, where: string): void {
  const short = fit.controls.filter((c) => c.height < TOUCH_TARGET_MIN_PX);
  expect(
    short.map((c) => `${c.label} ${c.height}px`),
    `${where}: ${short.length} of ${fit.controls.length} controls are under the ` +
      `${TOUCH_TARGET_MIN_PX}px touch-target floor.\n    ${describeBoxes(short)}`,
  ).toEqual([]);
}
