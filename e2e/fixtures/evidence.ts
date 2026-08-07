const BEARER_VALUE = /(bearer\s+)[a-z0-9._~-]+/gi;
const SUPABASE_KEY = /\bsb_(?:secret|publishable)_[a-z0-9_-]+\b/gi;
const JWT_VALUE = /\b[a-z0-9_-]{8,}\.[a-z0-9_-]{8,}\.[a-z0-9_-]{6,}\b/gi;
const AUTH_QUERY_VALUE = /([?&](?:code|token|token_hash|access_token|refresh_token)=)[^&\s]+/gi;

export function redactBrowserEvidence(value: string): string {
  return value
    .replace(BEARER_VALUE, "$1[redacted]")
    .replace(SUPABASE_KEY, "[redacted]")
    .replace(JWT_VALUE, "[redacted]")
    .replace(AUTH_QUERY_VALUE, "$1[redacted]");
}
