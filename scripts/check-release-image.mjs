import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export async function releaseAlreadyPublished({ repository, versionTag, latestTag, username, token }, request = fetch) {
  if (!/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/.test(repository)) throw new Error('Invalid image repository');
  const headers = token ? { Authorization: `Basic ${Buffer.from(`${username}:${token}`).toString('base64')}` } : {};
  const auth = await request(`https://ghcr.io/token?service=ghcr.io&scope=repository:${repository}:pull`, {
    headers, signal: AbortSignal.timeout(30000),
  });
  // Permission/network failures are not evidence that an image is missing or up to date.
  if (!auth.ok) throw new Error(`GHCR authentication failed: HTTP ${auth.status}`);
  const credentials = await auth.json();
  const accessToken = credentials.token || credentials.access_token;
  if (!accessToken) throw new Error('GHCR returned no access token');
  async function manifest(tag) {
    const response = await request(`https://ghcr.io/v2/${repository}/manifests/${encodeURIComponent(tag)}`, {
      headers: { Authorization: `Bearer ${accessToken}`,
        Accept: 'application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json' },
      signal: AbortSignal.timeout(30000),
    });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`GHCR manifest lookup failed: HTTP ${response.status}`);
    const data = await response.json();
    const platforms = new Set((data.manifests || [])
      .filter((entry) => entry.platform?.os === 'linux').map((entry) => entry.platform.architecture));
    const digest = response.headers.get('docker-content-digest');
    return digest && platforms.has('amd64') && platforms.has('arm64') ? digest : null;
  }
  const versionDigest = await manifest(versionTag);
  if (!versionDigest) return false;
  // Repair incomplete publication too: a version tag alone does not prove latest was updated.
  return !latestTag || versionDigest === await manifest(latestTag);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let build = true;
  if (process.env.GITHUB_EVENT_NAME === 'schedule' && process.env.VERSION_TAG) {
    build = !await releaseAlreadyPublished({ repository: process.env.GITHUB_REPOSITORY.toLowerCase(),
      versionTag: process.env.VERSION_TAG, latestTag: process.env.LATEST_TAG,
      username: process.env.GITHUB_ACTOR, token: process.env.GHCR_TOKEN });
  }
  appendFileSync(process.env.GITHUB_OUTPUT, `build=${build}\n`);
  const summary = build ? 'Build required (new release, missing image, or push/manual rebuild).'
    : `Skip build: ${process.env.VERSION_TAG} is already published for both platforms${process.env.LATEST_TAG ? ` and matches ${process.env.LATEST_TAG}` : ''}.`;
  console.log(summary);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`);
}
