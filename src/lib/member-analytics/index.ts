export type MemberRole = "owner" | "manager" | "staff";

export type MemberAnalyticsInput = {
  members: Array<{ memberId: string; userId: string; role: MemberRole }>;
  pours: Array<{ actorUserId: string | null; mlDelta: number; kind: string }>;
  adjustments: Array<{ actingUserId: string; kind: string }>;
  closeouts: Array<{ closedBy: string | null; varianceMl: number | null }>;
};

export type MemberAnalytics = {
  memberId: string;
  userId: string;
  role: MemberRole;
  pourCount: number;
  pourMl: number;
  compCount: number;
  compRate: number | null;
  compRateZScore: number | null;
  closeoutCount: number;
  closeoutVarianceMl: number;
  requiresVarianceInvestigation: boolean;
};

export type MemberAnalyticsResult = {
  houseMedianCompRate: number;
  members: MemberAnalytics[];
};

export function buildMemberAnalytics(
  input: MemberAnalyticsInput,
): MemberAnalyticsResult {
  const byUser = new Map(
    input.members.map((member) => [member.userId, emptyAnalytics(member)]),
  );

  for (const pour of input.pours) {
    if (pour.kind !== "pour" || !pour.actorUserId) continue;
    const member = byUser.get(pour.actorUserId);
    if (!member) continue;
    member.pourCount += 1;
    member.pourMl += pour.mlDelta;
  }
  for (const adjustment of input.adjustments) {
    if (adjustment.kind !== "comp") continue;
    const member = byUser.get(adjustment.actingUserId);
    if (member) member.compCount += 1;
  }
  for (const closeout of input.closeouts) {
    if (!closeout.closedBy) continue;
    const member = byUser.get(closeout.closedBy);
    if (!member) continue;
    member.closeoutCount += 1;
    member.closeoutVarianceMl += closeout.varianceMl ?? 0;
  }

  const members = [...byUser.values()];
  for (const member of members) {
    const serviceEvents = member.pourCount + member.compCount;
    // No observations means no rate — a zero here would drag the house
    // median down and make active members look anomalous.
    member.compRate = serviceEvents === 0 ? null : member.compCount / serviceEvents;
  }
  const active = members.filter((member) => member.compRate !== null);
  const rates = active.map((member) => member.compRate as number);
  const houseMedianCompRate = median(rates);
  const mean = rates.length === 0
    ? 0
    : rates.reduce((sum, rate) => sum + rate, 0) / rates.length;
  const variance = rates.length === 0
    ? 0
    : rates.reduce((sum, rate) => sum + (rate - mean) ** 2, 0) / rates.length;
  const deviation = Math.sqrt(variance);

  // A z-score flag needs enough signal to mean anything: at least
  // MIN_COHORT active members, and the member's own event count at least
  // MIN_MEMBER_EVENTS. Below that the state is insufficient-data, not
  // suspicion.
  const cohortSufficient = active.length >= MIN_COHORT;
  for (const member of members) {
    const serviceEvents = member.pourCount + member.compCount;
    member.compRateZScore =
      member.compRate === null || deviation === 0
        ? member.compRate === null ? null : 0
        : (member.compRate - mean) / deviation;
    const zFlag =
      cohortSufficient &&
      serviceEvents >= MIN_MEMBER_EVENTS &&
      member.compRateZScore !== null &&
      Math.abs(member.compRateZScore) >= 2;
    member.requiresVarianceInvestigation =
      zFlag || Math.abs(member.closeoutVarianceMl) >= 30;
  }

  return { houseMedianCompRate, members };
}

export const MIN_COHORT = 4;
export const MIN_MEMBER_EVENTS = 10;

function emptyAnalytics(
  member: MemberAnalyticsInput["members"][number],
): MemberAnalytics {
  return {
    ...member,
    pourCount: 0,
    pourMl: 0,
    compCount: 0,
    compRate: null,
    compRateZScore: null,
    closeoutCount: 0,
    closeoutVarianceMl: 0,
    requiresVarianceInvestigation: false,
  };
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const midpoint = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[midpoint - 1] + sorted[midpoint]) / 2
    : sorted[midpoint];
}
