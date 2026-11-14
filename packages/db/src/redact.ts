/**
 * Remove credentials from text before it is logged or returned. Applied to every database error message
 * (pg errors normally omit passwords, but connection strings can leak via driver/config errors).
 */
const URL_CREDENTIALS = /\b(postgres(?:ql)?|mysql|redis|https?):\/\/[^\s/@]*@/gi;
const KEY_VALUE = /\b(password|passwd|pwd|secret|token|apikey|api_key)\s*[=:]\s*("[^"]*"|'[^']*'|[^\s,;&]+)/gi;
const HOST_PORT = /\b([a-z0-9-]+\.)+(neon\.tech|neon\.build|hyperdrive\.local|cloudflare\.com)(:\d+)?\b/gi;

export function redact(text: string): string {
  return text
    .replace(URL_CREDENTIALS, (_m, scheme: string) => `${scheme}://***@`)
    .replace(KEY_VALUE, (_m, key: string) => `${key}=***`)
    .replace(HOST_PORT, '<db-host>');
}
