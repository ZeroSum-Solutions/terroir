// The palette-to-companion hand-off (P1 slice 2c, program plan D4: an
// all-scope miss "offers 'ask the companion'"). The search palette and the
// assistant trigger are separate client islands under a server layout, so a
// window event — not React context — carries "open the companion with this
// question" between them.

const OPEN_ASSISTANT_EVENT = "terroir:open-assistant";

type OpenAssistantDetail = { question: string | null };

/** Ask the assistant panel, wherever it is mounted, to open. */
export function requestAssistant(question: string | null): void {
  window.dispatchEvent(
    new CustomEvent<OpenAssistantDetail>(OPEN_ASSISTANT_EVENT, {
      detail: { question },
    }),
  );
}

/** Subscribe to open requests. Returns the unsubscribe. */
export function onAssistantRequest(
  listener: (question: string | null) => void,
): () => void {
  const handler = (event: Event) => {
    listener((event as CustomEvent<OpenAssistantDetail>).detail?.question ?? null);
  };
  window.addEventListener(OPEN_ASSISTANT_EVENT, handler);
  return () => window.removeEventListener(OPEN_ASSISTANT_EVENT, handler);
}
