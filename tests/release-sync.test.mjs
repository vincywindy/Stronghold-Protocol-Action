import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveUpstream } from '../scripts/resolve-upstream.mjs';
import { releaseAlreadyPublished } from '../scripts/check-release-image.mjs';

const stable = (tag) => ({ tag_name: tag, draft: false, prerelease: false, target_commitish: 'master' });
const response = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), { status, headers });
const source = { repository: 'sganggs/Stronghold-Protocol' };

test('latest resolves to its exact Git tag, not the release target branch', async () => {
  const actual = await resolveUpstream(source, async (url) => {
    assert.ok(url.endsWith('/releases/latest'));
    return response(stable('v0.2.1'));
  });
  assert.deepEqual(actual, { ref: 'refs/tags/v0.2.1', releaseTag: 'v0.2.1', isLatest: true });
});

test('explicit latest release retains version identity', async () => {
  const actual = await resolveUpstream({ ...source, ref: 'v0.2.1' }, async () => response(stable('v0.2.1')));
  assert.equal(actual.isLatest, true);
  assert.equal(actual.ref, 'refs/tags/v0.2.1');
});

test('historical releases resolve their tag without advancing latest', async () => {
  const actual = await resolveUpstream({ ...source, ref: 'v0.1.4' }, async (url) =>
    response(stable(url.endsWith('/latest') ? 'v0.2.1' : 'v0.1.4')));
  assert.deepEqual(actual, { ref: 'refs/tags/v0.1.4', releaseTag: 'v0.1.4', isLatest: false });
});

test('a branch without a release is still available for manual builds', async () => {
  const actual = await resolveUpstream({ ...source, ref: 'master' }, async (url) =>
    url.endsWith('/latest') ? response(stable('v0.2.1')) : response({}, 404));
  assert.deepEqual(actual, { ref: 'master', releaseTag: '', isLatest: false });
});

test('API errors, prereleases and incompatible tags cannot become latest', async () => {
  for (const [data, status] of [[{}, 403], [{ ...stable('v1'), prerelease: true }, 200],
    [stable('release/v1'), 200], [stable('v1\ninjected=true'), 200], [{}, 200]]) {
    await assert.rejects(resolveUpstream(source, async () => response(data, status)));
  }
});

const registry = { repository: 'example/game', versionTag: 'v0.2.1', latestTag: 'latest' };
const index = (arches = ['amd64', 'arm64']) => ({ manifests: arches.map((architecture) =>
  ({ platform: { os: 'linux', architecture } })) });
function registryMock({ versionStatus = 200, latestStatus = 200, latestDigest = 'sha256:one', arches } = {}) {
  return async (url) => {
    if (url.startsWith('https://ghcr.io/token?')) return response({ token: 'test-token' });
    const latest = url.endsWith('/latest');
    return response(index(arches), latest ? latestStatus : versionStatus,
      { 'docker-content-digest': latest ? latestDigest : 'sha256:one' });
  };
}

test('matching complete version and latest manifests allow skipping a release', async () => {
  assert.equal(await releaseAlreadyPublished(registry, registryMock()), true);
});

test('old images without 3D art are rebuilt even if the release tag is unchanged', async () => {
  assert.equal(await releaseAlreadyPublished({ ...registry, requireLocalAssets: true }, registryMock()), false);
  const request = async (url) => url.startsWith('https://ghcr.io/token?')
    ? response({ token: 'test-token' })
    : response({ ...index(), annotations: { 'io.github.stronghold-protocol.local-assets': 'release' } }, 200,
      { 'docker-content-digest': 'sha256:complete' });
  assert.equal(await releaseAlreadyPublished({ ...registry, requireLocalAssets: true }, request), true);
});

test('missing version, missing latest and stale latest all require a build', async () => {
  for (const options of [{ versionStatus: 404 }, { latestStatus: 404 }, { latestDigest: 'sha256:old' }]) {
    assert.equal(await releaseAlreadyPublished(registry, registryMock(options)), false);
  }
});

test('a single-architecture image does not count as a completed release', async () => {
  assert.equal(await releaseAlreadyPublished(registry, registryMock({ arches: ['amd64'] })), false);
});

test('pinned historical release only checks its own complete version image', async () => {
  assert.equal(await releaseAlreadyPublished({ ...registry, latestTag: '' },
    registryMock({ latestDigest: 'sha256:newer' })), true);
});

test('registry failures fail the check instead of silently skipping', async () => {
  await assert.rejects(releaseAlreadyPublished(registry, registryMock({ versionStatus: 500 })));
  await assert.rejects(releaseAlreadyPublished(registry, async () => response({}, 401)));
});

test('lite version checks use separate tags', async () => {
  const calls = [];
  const mock = registryMock();
  await releaseAlreadyPublished({ ...registry, versionTag: 'v0.2.1-lite', latestTag: 'latest-lite' },
    async (url, options) => { calls.push(url); return mock(url, options); });
  assert.ok(calls.some((url) => url.endsWith('/manifests/v0.2.1-lite')));
  assert.ok(calls.some((url) => url.endsWith('/manifests/latest-lite')));
});
