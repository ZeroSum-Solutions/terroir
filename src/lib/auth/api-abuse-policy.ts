import type { ApiRateLimitClass } from "@/lib/api/rate-limit";
import { API_AUTHORIZATION } from "./api-authorization";

export type ApiOperationId = `api:${string}:/api/${string}`;

export type ApiAbusePolicy =
  | {
      access: "public";
      rateLimit: "platform-health";
      idempotency: "none";
    }
  | {
      access: "authenticated";
      rateLimit: ApiRateLimitClass;
      idempotency: "none" | "supported";
    };

export const PLANNED_API_OPERATION_IDS = [] as const satisfies readonly ApiOperationId[];

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
} as const satisfies Partial<Record<ApiOperationId, ApiRateLimitClass>>;

const operationIds = [
  ...Object.keys(API_AUTHORIZATION),
  ...PLANNED_API_OPERATION_IDS,
] as ApiOperationId[];

export const API_ABUSE_POLICY = Object.fromEntries(
  operationIds.map((operationId) => [
    operationId,
    classifyOperation(operationId),
  ]),
) as Record<ApiOperationId, ApiAbusePolicy>;

function classifyOperation(operationId: ApiOperationId): ApiAbusePolicy {
  if (operationId === "api:GET:/api/health") {
    return {
      access: "public",
      rateLimit: "platform-health",
      idempotency: "none",
    };
  }
  const method = operationId.split(":")[1];
  const idempotency =
    method === "GET" || operationId === "api:POST:/api/pdf"
      ? "none"
      : "supported";
  const override = (
    RATE_LIMIT_OVERRIDES as Partial<
      Record<ApiOperationId, ApiRateLimitClass>
    >
  )[operationId];
  if (override) {
    return {
      access: "authenticated",
      rateLimit: override,
      idempotency,
    };
  }

  return {
    access: "authenticated",
    rateLimit: method === "GET" ? "standard" : "mutation",
    idempotency,
  };
}
