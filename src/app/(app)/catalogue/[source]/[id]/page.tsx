import type { Metadata } from "next";
import { notFound } from "next/navigation";
import * as Sentry from "@sentry/nextjs";
import { getAuthContext } from "@/lib/auth-context";
import {
  fetchXWinesProfileById,
  type CorpusRead,
  type XWinesProfile,
} from "@/lib/wine-intelligence/xwines-profile";
import { CatalogueDetailView } from "./catalogue-detail-view";
import type { CatalogueAddPayload } from "./catalogue-add-button";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Catalogue" };

// P1 slice 2b — /catalogue/[source]/[id], where a palette catalogue row
// lands (D4: "add-to-cellar-first is NOT required — catalogue rows get a
// detail view; add is one action on it").
//
// Keyed on the REFERENCE identity, not on query-string hints: an LWIN page
// re-derives its X-Wines features from the current accepted
// lwin_xwines_links decision, so the page can never show features a
// since-revoked link once claimed. Survival posture (AGENTS #7): 0145
// reaches production by hand, after this code — a failed links read
// degrades to "features unavailable", reported to Sentry, never a 500.

type Params = Promise<{ source: string; id: string }>;

// This segment catches /catalogue/<x>/<y> for any typed x and y; rejecting
// garbage here keeps a stray URL a clean 404 instead of a Postgres error.
// lwin_catalog is LWIN7-grained (its ids are seven digits); xwines_catalog
// wine_ids are integers.
const LWIN_ID = /^\d{7}$/;
const XWINES_ID = /^\d{1,9}$/;

function reportDegradation(phase: string, error: unknown, extra: Record<string, unknown>) {
  console.error(`catalogue detail: ${phase} degraded:`, error);
  Sentry.captureException(error instanceof Error ? error : new Error(JSON.stringify(error)), {
    tags: { surface: "catalogue-detail", phase },
    extra,
  });
}

type Supabase = NonNullable<Awaited<ReturnType<typeof getAuthContext>>>["supabase"];

const LWIN_COLUMNS =
  "lwin_id, display_name, producer, varietal, region, country, colour, type" as const;

function addPayloadFromLwin(row: {
  lwin_id: string;
  display_name: string;
  producer: string | null;
  region: string | null;
  country: string | null;
}): CatalogueAddPayload {
  return {
    lwin_id: row.lwin_id,
    display_name: row.display_name,
    producer: row.producer,
    region: row.region,
    country: row.country,
  };
}

async function renderLwin(supabase: Supabase, lwinId: string) {
  const { data: lwin, error: lwinError } = await supabase
    .from("lwin_catalog")
    .select(LWIN_COLUMNS)
    .eq("lwin_id", lwinId)
    .maybeSingle();
  // A failed query and an absent row are different facts; 404ing an outage
  // tells the reader the wine does not exist. Throw and let the error
  // boundary say the truthful thing.
  if (lwinError) throw lwinError;
  if (!lwin) notFound();

  // The current ACCEPTED linkage decision, followed to the corpus profile.
  let linkedWineId: number | null = null;
  let profile: CorpusRead<XWinesProfile | null> = { status: "ok", value: null };
  const { data: link, error: linkError } = await supabase
    .from("lwin_xwines_links")
    .select("xwines_wine_id")
    .eq("lwin_id", lwinId)
    .eq("status", "accepted")
    .maybeSingle();
  if (linkError) {
    reportDegradation("links-by-lwin", linkError, { lwinId });
    profile = { status: "unavailable" };
  } else if (link?.xwines_wine_id != null) {
    linkedWineId = link.xwines_wine_id;
    profile = await fetchXWinesProfileById(supabase, link.xwines_wine_id);
  }

  return (
    <CatalogueDetailView
      identity={{
        lwinId: lwin.lwin_id,
        xwinesWineId: linkedWineId,
        name: lwin.display_name,
        producer: lwin.producer,
        region: lwin.region,
        country: lwin.country,
        colour: lwin.colour,
        type: lwin.type,
        varietal: lwin.varietal,
      }}
      profile={profile}
      addPayload={addPayloadFromLwin(lwin)}
    />
  );
}

async function renderXwines(supabase: Supabase, wineId: number) {
  const profileRead = await fetchXWinesProfileById(supabase, wineId);
  // For an X-Wines page the corpus row IS the identity: an unreadable corpus
  // leaves nothing honest to render, so this is the error boundary's case,
  // not a degraded page's.
  if (profileRead.status === "unavailable") {
    throw new Error(`xwines_catalog row ${wineId} could not be read`);
  }
  const profile = profileRead.value;
  if (profile === null) notFound();

  // The reverse accepted link recovers an LWIN identity, which is what an
  // add needs — a wine without one stays informational (D4/A6: never a
  // provisional add out of a catalogue row).
  let addPayload: CatalogueAddPayload | null = null;
  let lwinId: string | null = null;
  const { data: link, error: linkError } = await supabase
    .from("lwin_xwines_links")
    .select("lwin_id")
    .eq("xwines_wine_id", wineId)
    .eq("status", "accepted")
    .maybeSingle();
  if (linkError) {
    // Add is an enhancement here; the page still stands on the corpus row.
    reportDegradation("links-by-xwines", linkError, { wineId });
  } else if (link?.lwin_id) {
    lwinId = link.lwin_id;
    const { data: lwin, error: lwinError } = await supabase
      .from("lwin_catalog")
      .select(LWIN_COLUMNS)
      .eq("lwin_id", link.lwin_id)
      .maybeSingle();
    if (lwinError) {
      reportDegradation("lwin-for-add", lwinError, { wineId, lwinId });
    } else if (lwin) {
      addPayload = addPayloadFromLwin(lwin);
    }
  }

  return (
    <CatalogueDetailView
      identity={{
        lwinId,
        xwinesWineId: wineId,
        name: profile.matchedName,
        producer: profile.matchedWinery,
        region: profile.regionName,
        country: profile.country,
        colour: null,
        type: profile.type,
        varietal: null,
      }}
      profile={{ status: "ok", value: profile }}
      addPayload={addPayload}
    />
  );
}

export default async function CatalogueDetailPage({ params }: { params: Params }) {
  const { source, id } = await params;
  if (source !== "lwin" && source !== "xwines") notFound();
  if (source === "lwin" && !LWIN_ID.test(id)) notFound();
  if (source === "xwines" && !XWINES_ID.test(id)) notFound();

  // AppLayout redirects when the session is null, so reaching here means a
  // membership exists.
  const auth = (await getAuthContext())!;
  const { supabase } = auth;

  return source === "lwin"
    ? renderLwin(supabase, id)
    : renderXwines(supabase, Number.parseInt(id, 10));
}
