import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export function imageMetadata(env) {
  const image = `ghcr.io/${env.GITHUB_REPOSITORY.toLowerCase()}`;
  const sha = env.UPSTREAM_SHA;
  if (!/^[a-f0-9]{40}$/.test(sha)) throw new Error('Expected a full upstream commit SHA');
  if (!/^[a-z0-9][a-z0-9_.-]*\/[a-z0-9][a-z0-9_.-]*$/.test(env.GITHUB_REPOSITORY.toLowerCase())) {
    throw new Error('Invalid GitHub repository name');
  }
  if (!['0', '1'].includes(env.FETCH_ASSETS)) throw new Error('FETCH_ASSETS must be 0 or 1');
  const suffix = env.FETCH_ASSETS === '1' ? '' : '-lite';
  const manual = env.GITHUB_EVENT_NAME === 'workflow_dispatch' && env.AUTOMATED_BUILD !== 'true';
  const customTag = env.IMAGE_TAG || '';
  const hasPlugins = Boolean(env.SELECTED_PLUGINS?.trim());
  if (hasPlugins && (!manual || !customTag)) throw new Error('Plugin builds require a manual build and an explicit image_tag');
  if (customTag && !manual) throw new Error('image_tag is only allowed for manual builds');
  // Keep manual/custom builds out of latest, upstream-SHA and semantic-release namespaces.
  if (customTag && (!/^[\w][\w.-]{0,127}$/.test(customTag) || /^(latest(?:-|$)|sha-|v?\d+\.\d+\.\d+)/i.test(customTag))) {
    throw new Error('Invalid image_tag: use a custom name, not latest, sha-* or a release version');
  }
  const publish = ['push', 'schedule', 'workflow_dispatch'].includes(env.GITHUB_EVENT_NAME)
    && env.GITHUB_REF === `refs/heads/${env.DEFAULT_BRANCH}`;
  if (manual) {
    const tag = customTag || `manual-${env.GITHUB_RUN_ID}-${env.GITHUB_RUN_ATTEMPT}${suffix}`;
    if (!customTag && !/^manual-\d+-\d+(?:-lite)?$/.test(tag)) throw new Error('Manual builds need run ID/attempt or image_tag');
    return { image, publish, tags: [`${image}:${tag}`], versionTag: tag, checkTag: tag, latestTag: '', version: tag };
  }
  const tags = [`${image}:sha-${sha}${suffix}`];
  const release = env.RELEASE_TAG || '';
  if (release && (!/^[\w][\w.-]{0,122}$/.test(release) || /^(latest|sha-)/.test(release))) {
    throw new Error('Invalid release tag');
  }
  const versionTag = release ? `${release}${suffix}` : '';
  // Unreleased refs are deduplicated by resolved commit without creating a release/latest tag.
  const checkTag = versionTag || `sha-${sha}${suffix}`;
  const latestTag = `latest${suffix}`;
  if (versionTag) tags.push(`${image}:${versionTag}`);
  // Only the current stable release may advance latest; branches and old releases cannot.
  if (release && env.IS_LATEST_RELEASE === 'true') tags.push(`${image}:${latestTag}`);
  return { image, publish, tags, versionTag, checkTag, latestTag, version: release || sha };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = imageMetadata(process.env);
  appendFileSync(process.env.GITHUB_OUTPUT,
    `image=${result.image}\npublish=${result.publish}\nversion_tag=${result.versionTag}\ncheck_tag=${result.checkTag}\nlatest_tag=${result.latestTag}\nversion=${result.version}\ntags<<IMAGE_TAGS\n${result.tags.join('\n')}\nIMAGE_TAGS\n`);
  console.log(JSON.stringify(result, null, 2));
}
