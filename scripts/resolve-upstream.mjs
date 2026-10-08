import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export async function resolveUpstream({ repository, ref = 'latest', token }, request = fetch) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository)) throw new Error('Invalid upstream repository');
  if (!ref || /[\r\n]/.test(ref)) throw new Error('Invalid upstream ref');
  async function release(endpoint, optional = false) {
    const response = await request(`https://api.github.com/repos/${repository}/releases/${endpoint}`, {
      headers: { Accept: 'application/vnd.github+json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      signal: AbortSignal.timeout(30000),
    });
    if (optional && response.status === 404) return null;
    if (!response.ok) throw new Error(`GitHub release lookup failed: HTTP ${response.status}`);
    const data = await response.json();
    if (data.draft || data.prerelease) {
      if (optional) return null;
      throw new Error('Expected a published stable release');
    }
    // Preserve the exact release name; sanitizing it would silently change the Docker version.
    if (typeof data.tag_name !== 'string' || !/^[\w][\w.-]{0,122}$/.test(data.tag_name) || /^(latest|sha-)/.test(data.tag_name)) {
      throw new Error('Release tag cannot be represented safely as a Docker tag (including -lite)');
    }
    return data;
  }
  const latest = await release('latest');
  const selected = ref === 'latest' || ref === latest.tag_name
    ? latest : await release(`tags/${encodeURIComponent(ref)}`, true);
  return {
    // A release must resolve its Git tag, never a same-named branch or target_commitish.
    ref: selected ? `refs/tags/${selected.tag_name}` : ref,
    releaseTag: selected?.tag_name || '',
    isLatest: selected?.tag_name === latest.tag_name,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await resolveUpstream({ repository: process.env.UPSTREAM_REPOSITORY,
    ref: process.env.REQUESTED_REF, token: process.env.GITHUB_TOKEN });
  appendFileSync(process.env.GITHUB_OUTPUT,
    `ref=${result.ref}\nrelease_tag=${result.releaseTag}\nis_latest=${result.isLatest}\n`);
  console.log(JSON.stringify(result, null, 2));
}
