// Map a git remote URL to an "owner/name" GitHub repo slug. Pure.

/**
 * @param {string|null|undefined} url a git remote URL
 * @returns {string|null} "owner/name" or null when not a GitHub remote
 */
export function repoFromRemoteUrl(url) {
  if (!url || typeof url !== 'string') return null;
  const trimmed = url.trim().replace(/\/+$/, ''); // tolerate trailing slash(es)

  // scp-style: git@github.com:owner/name(.git)
  let m = /^git@github\.com:([^/]+)\/(.+?)(?:\.git)?$/.exec(trimmed);
  if (m) return `${m[1]}/${m[2]}`;

  // ssh://[user@]github.com[:port]/owner/name(.git)  or
  // http(s)://[user[:token]@]github.com[:port]/owner/name(.git)
  // The optional userinfo covers credential-embedded HTTPS remotes (CI / PATs),
  // and the optional :port covers ssh-on-a-nonstandard-port configs.
  m = /^(?:ssh:\/\/|https?:\/\/)(?:[^@/]+@)?github\.com(?::\d+)?\/([^/]+)\/(.+?)(?:\.git)?$/.exec(trimmed);
  if (m) return `${m[1]}/${m[2]}`;

  return null;
}
