import { appendFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export function dockerhubConfig(env) {
  // Both credentials are required to opt in; partial configuration must not block GHCR.
  if (!env.DOCKERHUB_USERNAME?.trim() || !env.DOCKERHUB_TOKEN?.trim()) return { enabled: false };
  const repository = env.DOCKERHUB_REPOSITORY?.trim()
    || `${env.DOCKERHUB_USERNAME.trim()}/${env.GITHUB_REPOSITORY.split('/')[1]}`.toLowerCase();
  if (!/^[a-z0-9]+(?:[._-][a-z0-9]+)*\/[a-z0-9]+(?:[._-]+[a-z0-9]+)*$/.test(repository)) {
    throw new Error('DOCKERHUB_REPOSITORY must be a lowercase namespace/repository without a registry or tag');
  }
  return { enabled: true, repository };
}

// Capture stderr so an expected missing-tag probe cannot print Skopeo's misleading "fatal" log.
// Unexpected failures still propagate with the captured stderr attached to the error.
const skopeo = (args) => execFileSync('skopeo', args, {
  encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
});
const digest = (raw) => `sha256:${createHash('sha256').update(raw).digest('hex')}`;

export function mirrorToDockerhub({ sourceImage, sourceTag, tags, repository }, run = skopeo, log = console.log) {
  const source = `${sourceImage}:${sourceTag}`;
  const raw = run(['inspect', '--raw', `docker://${source}`]);
  const manifest = JSON.parse(raw);
  const platforms = new Set((manifest.manifests || []).filter((m) => m.platform?.os === 'linux')
    .map((m) => m.platform.architecture));
  if (!platforms.has('amd64') || !platforms.has('arm64')) throw new Error('Source is not a complete multi-platform image');
  // Pin the tested index before copying any tags; --all also retains SBOM/provenance manifests.
  const sourceDigest = digest(raw);
  const published = [];
  for (const tag of tags) {
    if (!tag.startsWith(`${sourceImage}:`)) throw new Error('Unexpected source tag');
    const destination = `docker.io/${repository}:${tag.slice(sourceImage.length + 1)}`;
    let current;
    try {
      current = run(['inspect', '--raw', `docker://${destination}`]);
    } catch (error) {
      // Only a registry's missing-manifest response is normal on first publication, not auth/network errors.
      if (!/\b(?:manifest|name)[ _]unknown\b/i.test(String(error.stderr || error.message))) throw error;
      log(`Tag does not exist yet; it will be created: ${destination}`);
    }
    if (!current || digest(current) !== sourceDigest) {
      log(`Copying multi-platform image to ${destination}`);
      run(['copy', '--all', '--preserve-digests', '--retry-times', '3',
        `docker://${sourceImage}@${sourceDigest}`, `docker://${destination}`]);
      const copied = run(['inspect', '--raw', `docker://${destination}`]);
      if (digest(copied) !== sourceDigest) throw new Error(`Digest mismatch after copying ${destination}`);
      log(`Published and verified: ${destination} (${sourceDigest})`);
    } else {
      log(`Already synchronized: ${destination} (${sourceDigest})`);
    }
    published.push(destination);
  }
  return published;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv[2] === 'configure') {
    const config = dockerhubConfig(process.env);
    appendFileSync(process.env.GITHUB_OUTPUT, `enabled=${config.enabled}\nrepository=${config.repository || ''}\n`);
    if (!config.enabled) {
      const message = 'Docker Hub skipped: configure both DOCKERHUB_USERNAME and DOCKERHUB_TOKEN secrets to enable publishing.';
      console.log(message);
      appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${message}\n`);
    }
  } else if (process.argv[2] === 'mirror') {
    const tags = process.env.IMAGE_TAGS.trim().split('\n');
    const published = mirrorToDockerhub({ sourceImage: process.env.IMAGE,
      sourceTag: process.env.VERSION_TAG || tags[0].split(':').at(-1),
      tags, repository: process.env.DOCKERHUB_REPOSITORY });
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### Docker Hub (verified multi-platform images)\n${published.map((tag) => `- ${tag}`).join('\n')}\n`);
    console.log(published.join('\n'));
  } else {
    throw new Error('Expected configure or mirror');
  }
}
