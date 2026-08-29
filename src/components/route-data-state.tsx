"use client";

import type { ReactNode } from "react";

export function RouteDataLoading({
  label,
  children,
}: {
  label: string;
  children?: ReactNode;
}): ReactNode {
  return (
    <div
      role="status"
      aria-live="polite"
      aria-busy="true"
      className="rounded-card card-surface p-lg text-grey"
    >
      <p className="text-[14px]">{label}</p>
      {children}
    </div>
  );
}

export function RouteDataError({
  title,
  description,
  onRetry,
}: {
  title: string;
  description: string;
  onRetry: () => void;
}): ReactNode {
  return (
    <section
      role="alert"
      className="rounded-card shadow-card border border-hairline bg-blush-wash p-lg text-ink"
    >
      <h2 className="text-[16px] font-medium">{title}</h2>
      <p className="mt-xs text-[14px] text-grey">{description}</p>
      <button
        type="button"
        onClick={onRetry}
        className="mt-md inline-flex h-11 items-center rounded-pill bg-primary px-lg text-[14px] font-medium text-white hover:bg-primary-hover focus-ring"
      >
        Try again
      </button>
    </section>
  );
}

export function RouteDataEmpty({
  icon,
  title,
  description,
  action,
}: {
  icon: ReactNode;
  title: string;
  description: string;
  action?: ReactNode;
}): ReactNode {
  return (
    <section
      aria-label={title}
      className="rounded-card card-surface p-xl text-center text-ink"
    >
      <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-blush-wash text-accent">
        {icon}
      </div>
      <h2 className="mt-md text-[16px] font-medium">{title}</h2>
      <p className="mt-xs text-[14px] text-grey">{description}</p>
      {action ? <div className="mt-lg">{action}</div> : null}
    </section>
  );
}
