import type { Metadata } from "next";
import { ReconcileQueueClient } from "./reconcile-queue-client";

export const metadata: Metadata = { title: "Reconciliation queue" };

export default function ReconciliationQueuePage() {
  return <section><ReconcileQueueClient /></section>;
}
