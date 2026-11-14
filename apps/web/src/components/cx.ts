/** Join class names, skipping falsy values. Always returns a string (CSS Module lookups may be undefined). */
export function cx(...names: (string | false | null | undefined)[]): string {
  return names.filter(Boolean).join(' ');
}
