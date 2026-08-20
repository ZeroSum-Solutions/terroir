import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import { NextResponse } from "next/server";
import { z } from "zod";
import { requireRole } from "@/lib/api/auth";
import { Errors } from "@/lib/api/errors";
import { runPricingRecommendationsRecompute } from "@/lib/pricing-recommendations/recompute";
import type { Database } from "@/types/database";

export const runtime = "nodejs";

const ServiceConfigSchema = z.object({
  url: z.url(),
  serviceKey: z.string().trim().min(1),
});

export async function POST() {
  const auth = await requireRole(["owner", "manager"]);
  if (auth instanceof NextResponse) return auth;

  const config = ServiceConfigSchema.safeParse({
    url: process.env.NEXT_PUBLIC_SUPABASE_URL,
    serviceKey: process.env.SUPABASE_SERVICE_ROLE_KEY,
  });
  if (!config.success) {
    console.error("pricing recommendations service-role configuration is invalid");
    return Errors.internal("Pricing recommendations recompute is unavailable.");
  }

  const admin = createSupabaseClient<Database>(
    config.data.url,
    config.data.serviceKey,
    { auth: { persistSession: false } },
  );
  try {
    const result = await runPricingRecommendationsRecompute(
      admin,
      auth.restaurantId,
      auth.user.id,
    );
    return NextResponse.json(result);
  } catch (error) {
    console.error("pricing recommendations recompute failed", error);
    return Errors.internal("Pricing recommendations recompute failed.");
  }
}
