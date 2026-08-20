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
  compRate: number;
  compRateZScore: number;
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
    member.compRate = serviceEvents === 0 ? 0 : member.compCount / serviceEvents;
  }
  const rates = members.map((member) => member.compRate);
  const houseMedianCompRate = median(rates);
  const mean = rates.length === 0
    ? 0
    : rates.reduce((sum, rate) => sum + rate, 0) / rates.length;
  const variance = rates.length === 0
    ? 0
    : rates.reduce((sum, rate) => sum + (rate - mean) ** 2, 0) / rates.length;
  const deviation = Math.sqrt(variance);

  for (const member of members) {
    member.compRateZScore = deviation === 0 ? 0 : (member.compRate - mean) / deviation;
    member.requiresVarianceInvestigation =
      Math.abs(member.compRateZScore) >= 2 ||
      Math.abs(member.closeoutVarianceMl) >= 30;
  }

  return { houseMedianCompRate, members };
}

function emptyAnalytics(
  member: MemberAnalyticsInput["members"][number],
): MemberAnalytics {
  return {
    ...member,
    pourCount: 0,
    pourMl: 0,
    compCount: 0,
    compRate: 0,
    compRateZScore: 0,
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
