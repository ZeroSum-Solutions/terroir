import { AxisBar, Section } from "@/components/detail-sections";
import type { XWinesProfile } from "@/lib/wine-intelligence/xwines-profile";

export function TasteAxesSection({ profile }: { profile: XWinesProfile }) {
  return (
    <Section title="What does this wine taste like?">
      <div className="grid gap-xl md:grid-cols-[minmax(0,1fr)_minmax(0,280px)]">
        <div className="flex flex-col gap-lg">
          {profile.body && <AxisBar axis={profile.body} />}
          {profile.acidity && <AxisBar axis={profile.acidity} />}
        </div>
        <p className="text-body-sm text-grey">
          Structure for{" "}
          <span className="text-ink-soft">{profile.matchedName}</span>{" "}
          from the X-Wines reference corpus. It describes body and acidity
          only — tannin and sweetness aren&rsquo;t recorded, so they
          aren&rsquo;t shown.
        </p>
      </div>
    </Section>
  );
}
