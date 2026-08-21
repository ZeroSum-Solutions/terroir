export function InsightScope(
  props:
    | { metric: string; kind: "snapshot" }
    | { metric: string; kind: "range"; label: string },
) {
  const text = props.kind === "snapshot" ? "Current snapshot" : props.label;
  return (
    <span
      data-insight-scope={props.metric}
      className="text-[11px] font-medium uppercase tracking-wide text-ink-muted"
    >
      {text}
    </span>
  );
}
