import type { Metadata } from "next";

export const metadata: Metadata = { title: "Invitation" };

export default function InviteLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return children;
}
