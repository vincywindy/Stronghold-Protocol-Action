import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { resolveUpstream } from './resolve-upstream.mjs';
import { imageMetadata } from './image-metadata.mjs';
import { publishedReleaseDigest } from './check-release-image.mjs';
import { dockerhubConfig, dockerhubAlreadySynced } from './dockerhub.mjs';

export async function checkUpstream(env, request = fetch) {
  const upstream = await resolveUpstream({ repository: env.UPSTREAM_REPOSITORY,
    ref: env.REQUESTED_REF, token: env.GITHUB_TOKEN }, request);
  // Resolve refs through the API instead of checking out the game's source for every poll.
  const commit = await request(`https://api.github.com/repos/${env.UPSTREAM_REPOSITORY}/commits/${encodeURIComponent(upstream.ref)}`, {
    headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${env.GITHUB_TOKEN}` },
    signal: AbortSignal.timeout(30000),
  });
  if (!commit.ok) throw new Error(`GitHub commit lookup failed: HTTP ${commit.status}`);
  const metadata = imageMetadata({ ...env, UPSTREAM_SHA: (await commit.json()).sha,
    RELEASE_TAG: upstream.releaseTag, IS_LATEST_RELEASE: String(upstream.isLatest) });
  const sourceDigest = await publishedReleaseDigest({ repository: env.GITHUB_REPOSITORY.toLowerCase(),
    versionTag: metadata.checkTag, latestTag: upstream.isLatest ? metadata.latestTag : '',
    username: env.GITHUB_ACTOR, token: env.GITHUB_TOKEN,
    requireLocalAssets: Boolean(upstream.releaseTag) && env.FETCH_ASSETS === '1' }, request);
  if (!sourceDigest) return { needed: true, reason: `${metadata.checkTag}: GHCR publication is missing or incomplete.` };

  const hub = dockerhubConfig(env);
  if (hub.enabled && !await dockerhubAlreadySynced({ repository: hub.repository,
    username: env.DOCKERHUB_USERNAME.trim(), token: env.DOCKERHUB_TOKEN.trim(), sourceDigest,
    tags: metadata.tags.map((tag) => tag.slice(metadata.image.length + 1)) }, request)) {
    return { needed: true, reason: `${metadata.checkTag}: Docker Hub mirror needs repair (GHCR build can be skipped).` };
  }
  return { needed: false, reason: `${metadata.checkTag}: all configured registries are up to date.` };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await checkUpstream(process.env);
  appendFileSync(process.env.GITHUB_OUTPUT, `publish_needed=${result.needed}\n`);
  console.log(result.reason);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${result.reason}\n`);
}
