import { notFound } from "next/navigation";

type Params = Promise<{ slug: string }>;

export default async function PublicWineListPage({ params }: { params: Params }) {
  const { slug } = await params;

  // Placeholder until we wire Supabase + RLS for public-by-slug reads.
  if (!slug || slug.length < 3) notFound();

  return (
    <main className="mx-auto min-h-screen max-w-[720px] px-lg py-3xl">
      <header className="mb-2xl border-b border-border pb-xl">
        <p className="text-[11px] uppercase tracking-[0.08em] text-ink-subtle">
          Wine List
        </p>
        <h1 className="mt-sm font-serif text-[28px] text-ink">
          {slug.replace(/-[a-z0-9]{3,4}$/i, "").replace(/-/g, " ")}
        </h1>
      </header>
      <p className="text-[14px] italic text-ink-muted">
        Stub — published wines render here, mobile-first, always current.
      </p>
    </main>
  );
}
