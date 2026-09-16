/**
 * Expand tool families so `tools: ['filesystem', 'git']` means
 * `filesystem.*` and `git.*` (spec §6 example), while fully qualified ids such
 * as `mcp.github.create_issue` pass through untouched.
 */
export function expandToolFamilies(ids: string[]): string[] {
  const expanded: string[] = [];
  for (const id of ids) {
    const normalized = id.includes('.') || id.includes('_') || id === '*' ? id : `${id}.*`;
    if (!expanded.includes(normalized)) expanded.push(normalized);
  }
  return expanded;
}
