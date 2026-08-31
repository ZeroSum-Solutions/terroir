import type { Metadata } from "next";
import { getAuthContext } from "@/lib/auth-context";
import { ReconcileQueueClient } from "./reconcile-queue-client";

export const metadata: Metadata = { title: "Reconciliation queue" };

/**
 * The queue itself is readable by any member (`GET /api/reconcile-queue`
 * gates on membership), but accepting and undoing a batch are owner/manager
 * only — both POST routes call `requireRole(["owner", "manager"])`. The page
 * used to render the bulk rail and the undo button for everyone, so a staff
 * member could select rows, press Accept, and only then be told 403. The
 * affordance now matches the permission, the same way /bins passes
 * `canManage` down from `userRole`.
 */
export default async function ReconciliationQueuePage() {
  const auth = (await getAuthContext())!; // AppLayout redirects when null
  const canManage = auth.userRole === "owner" || auth.userRole === "manager";
  return <section><ReconcileQueueClient canManage={canManage} /></section>;
}
