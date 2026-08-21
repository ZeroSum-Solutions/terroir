type Role = "owner" | "manager" | "staff";

const ROLE_LABEL: Record<Role, string> = {
  owner: "Owner",
  manager: "Manager",
  staff: "Staff",
};

export function roleLabel(role: Role): string {
  return ROLE_LABEL[role];
}

export function ShellContext({
  restaurantName,
  role,
}: {
  restaurantName: string | null;
  role: Role;
}) {
  return (
    <div
      role="group"
      data-shell-context="true"
      className="ml-sm flex min-w-0 items-center gap-xs border-l border-hairline pl-sm md:ml-md md:gap-sm md:pl-md"
    >
      <span className="max-w-[112px] truncate text-[11px] font-medium text-ink md:max-w-[220px] md:text-[12px]">
        {restaurantName?.trim() || "Unnamed restaurant"}
      </span>
      <span className="shrink-0 rounded-pill bg-beige px-sm py-2xs text-[10px] font-medium uppercase tracking-wide text-ink-soft">
        {roleLabel(role)}
      </span>
    </div>
  );
}
