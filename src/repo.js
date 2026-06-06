// Map a git remote URL to an "owner/name" GitHub repo slug. Pure.

/**
 * @param {string|null|undefined} url a git remote URL
 * @returns {string|null} "owner/name" or null when not a GitHub remote
 */
export function repoFromRemoteUrl(url) {
  if (!url || typeof url !== 'string') return null;
  const trimmed = url.trim();

  // scp-style: git@github.com:owner/name(.git)
  let m = /^git@github\.com:([^/]+)\/(.+?)(?:\.git)?$/.exec(trimmed);
  if (m) return `${m[1]}/${m[2]}`;

  // ssh://git@github.com/owner/name(.git)  or  https://github.com/owner/name(.git)
  m = /^(?:ssh:\/\/git@|https?:\/\/)github\.com\/([^/]+)\/(.+?)(?:\.git)?$/.exec(trimmed);
  if (m) return `${m[1]}/${m[2]}`;

  return null;
}
