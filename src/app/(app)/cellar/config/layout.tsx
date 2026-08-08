import { redirect } from "next/navigation";
import { getAuthContext } from "@/lib/auth-context";

export default async function CellarConfigLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const auth = await getAuthContext();
  if (!auth || auth.userRole === "staff") redirect("/cellar");
  return children;
}
