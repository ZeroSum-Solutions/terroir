/**
 * Route-scoped 404 for the public wine-list segment.
 *
 * page.tsx calls notFound() when the slug doesn't resolve to a
 * published list — most often because the link was shared after
 * the list was unpublished, renamed, or removed. The default
 * Next.js 404 reads as a developer error; this version explains
 * the likely cause in plain language and matches the typography
 * of the actual list page so a stale QR code still looks like
 * part of the same surface.
 *
 * No restaurant details are exposed — the slug isn't authenticated
 * and we don't want to confirm whether a given list ever existed.
 */
export default function PublicWineListNotFound() {
  return (
    <main className="mx-auto flex min-h-screen max-w-[480px] flex-col items-center justify-center bg-surface px-lg py-3xl text-center">
      <p className="text-caption uppercase text-grey">
        Wine list
      </p>
      <h1 className="mt-sm font-serif text-heading-sm text-ink">
        This list isn&rsquo;t available
      </h1>
      <p className="mt-md text-[15px] leading-relaxed text-ink-muted">
        The link may be out of date, or the restaurant may have unpublished
        their list. Ask them for an updated link and try again.
      </p>
      <p className="mt-2xl text-[12px] text-ink-subtle">
        Powered by{" "}
        <span className="font-serif font-medium text-primary">Terroir</span>
      </p>
    </main>
  );
}
