import type { ApiRateLimitClass } from "@/lib/api/rate-limit";
import { API_AUTHORIZATION } from "./api-authorization";

type OperationId = `api:${string}:/api/${string}`;

export type ApiAbusePolicy =
  | {
      access: "public";
      rateLimit: "platform-health" | "public-bootstrap";
    }
  | {
      access: "authenticated";
      rateLimit: ApiRateLimitClass;
    };

export const PLANNED_API_OPERATION_IDS = [
  "api:GET:/api/cellar",
  "api:GET:/api/export",
  "api:GET:/api/inventory",
  "api:GET:/api/restaurant",
  "api:PATCH:/api/restaurant",
  "api:GET:/api/scans",
  "api:GET:/api/scans/{param}",
  "api:GET:/api/team",
  "api:POST:/api/team",
  "api:DELETE:/api/team/{param}",
  "api:GET:/api/wine-list-items",
  "api:GET:/api/wine-list-sections",
  "api:GET:/api/wine-lists",
  "api:GET:/api/wines",
  "api:GET:/api/wines/{param}",
] as const satisfies readonly OperationId[];

const RATE_LIMIT_OVERRIDES = {
  "api:POST:/api/pdf": "expensive",
  "api:POST:/api/scan": "expensive",
  "api:POST:/api/scan-bottle": "expensive",
  "api:POST:/api/scans/{param}/re-extract": "expensive",
  "api:POST:/api/team/accept-invite": "sensitive",
  "api:POST:/api/team/invite": "sensitive",
  "api:POST:/api/team/invite/{param}/resend": "sensitive",
  "api:POST:/api/wines/{param}/enrich": "expensive",
  "api:POST:/api/wines/{param}/refresh-retail": "expensive",
  "api:POST:/api/wines/enrich": "expensive",
  "api:POST:/api/wines/refresh-retail-batch": "expensive",
  "api:POST:/api/team": "sensitive",
} as const satisfies Partial<Record<OperationId, ApiRateLimitClass>>;

const operationIds = [
  ...Object.keys(API_AUTHORIZATION),
  ...PLANNED_API_OPERATION_IDS,
] as OperationId[];

export const API_ABUSE_POLICY = Object.fromEntries(
  operationIds.map((operationId) => [
    operationId,
    classifyOperation(operationId),
  ]),
) as Record<OperationId, ApiAbusePolicy>;

function classifyOperation(operationId: OperationId): ApiAbusePolicy {
  if (operationId === "api:GET:/api/health") {
    return { access: "public", rateLimit: "platform-health" };
  }
  if (operationId === "api:GET:/api/dev-login") {
    return { access: "public", rateLimit: "public-bootstrap" };
  }

  const override = (
    RATE_LIMIT_OVERRIDES as Partial<
      Record<OperationId, ApiRateLimitClass>
    >
  )[operationId];
  if (override) return { access: "authenticated", rateLimit: override };

  const method = operationId.split(":")[1];
  return {
    access: "authenticated",
    rateLimit: method === "GET" ? "standard" : "mutation",
  };
}
