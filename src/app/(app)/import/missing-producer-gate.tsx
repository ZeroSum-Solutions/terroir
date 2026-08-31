"use client";

// SD-41 — the preview's blank-producer gate.
//
// This replaces a `role="status"` panel that counted producer-less rows and
// warned about them without requiring anything of anyone. That warning is
// how 1,277 wines were written with an empty producer and the producer name
// buried in `name`; 321 of them are still unrepaired in production. See
// src/domains/import/producer-acknowledgement.ts for why an acknowledgement
// — rather than a rejection or a silent write-time repair — is the right
// shape here, and note that the SERVER is what actually enforces it: this
// checkbox is the affordance, not the guard.

export function MissingProducerGate({
  missingProducerRows,
  acknowledged,
  onAcknowledge,
  disabled,
}: {
  /** Rows that will import with no producer at all — the operator's own
   * inline fixes counted in, a skipped chunk counted out (see
   * computePreviewCounts). Zero renders nothing. */
  missingProducerRows: number;
  acknowledged: boolean;
  onAcknowledge: (acknowledged: boolean) => void;
  disabled: boolean;
}) {
  if (missingProducerRows <= 0) return null;
  const plural = missingProducerRows === 1;
  return (
    <div className="mt-xs rounded-md bg-risk-wash px-sm py-xs text-body-sm text-risk-ink">
      <p>
        {missingProducerRows} row{plural ? " has" : "s have"} no producer. {plural ? "It" : "They"} will import, but a
        wine with no producer cannot be matched to the shared catalogue — so it will never gain a label photograph, a
        region, or a drink window. Add a producer/winery column to your file if you have one.
      </p>
      {/* No size class — the panel's own text-body-sm is the right size
          here, and the typography ratchet has no role for a bare pixel
          value (DESIGN.md scale tokens only). */}
      <label className="mt-xs flex items-center gap-sm font-medium">
        <input
          type="checkbox"
          checked={acknowledged}
          disabled={disabled}
          onChange={(e) => onAcknowledge(e.target.checked)}
          className="h-5 w-5 rounded-sm border-rule"
        />
        <span>Import {plural ? "it" : "them"} without a producer</span>
      </label>
    </div>
  );
}
