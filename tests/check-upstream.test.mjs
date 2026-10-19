import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { checkUpstream } from '../scripts/check-upstream.mjs';

const sha = 'a'.repeat(40);
const env = { UPSTREAM_REPOSITORY: 'upstream/game', REQUESTED_REF: 'latest',
  GITHUB_REPOSITORY: 'Owner/Game', GITHUB_ACTOR: 'owner', GITHUB_TOKEN: 'test-token', FETCH_ASSETS: '1' };
const hubEnv = { ...env, DOCKERHUB_USERNAME: 'owner', DOCKERHUB_TOKEN: 'hub-token' };
const response = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers });
const index = { manifests: ['amd64', 'arm64'].map((architecture) => ({ platform: { os: 'linux', architecture } })),
  annotations: { 'io.github.stronghold-protocol.local-assets': 'release' } };
function mock({ ghcrMissing = false, hubMissing = '', hubStatus = 200, hubDigest = 'sha256:complete', release = true } = {}) {
  const calls = [];
  const request = async (url, options) => {
    calls.push({ url, options });
    if (url.includes('/releases/')) return response({ tag_name: 'v1', draft: false, prerelease: false },
      !release && url.includes('/tags/') ? 404 : 200);
    if (url.includes('/commits/')) return response({ sha });
    if (url.startsWith('https://ghcr.io/token?') || url.startsWith('https://auth.docker.io/token?')) {
      return response({ token: 'registry-token' });
    }
    if (url.startsWith('https://ghcr.io/v2/')) return response(index, ghcrMissing ? 404 : 200,
      { 'docker-content-digest': 'sha256:complete' });
    if (url.startsWith('https://registry-1.docker.io/v2/')) return response({},
      hubMissing && url.endsWith(`/manifests/${hubMissing}`) ? 404 : hubStatus,
      hubDigest ? { 'docker-content-digest': hubDigest } : {});
    throw new Error(`Unexpected URL: ${url}`);
  };
  return { request, calls };
}

test('unchanged complete release ends the poll without dispatching publication', async () => {
  const { request, calls } = mock();
  assert.equal((await checkUpstream(env, request)).needed, false);
  assert.ok(calls.some(({ url }) => url.endsWith('/commits/refs%2Ftags%2Fv1')));
  assert.ok(calls.every(({ url }) => !url.includes('docker.io')));
});

test('missing GHCR publication requests a build before probing Docker Hub', async () => {
  const { request, calls } = mock({ ghcrMissing: true });
  assert.equal((await checkUpstream(hubEnv, request)).needed, true);
  assert.ok(calls.every(({ url }) => !url.includes('docker.io')));
});

test('complete Docker Hub copy skips publication; every expected alias is checked via HEAD', async () => {
  const { request, calls } = mock();
  assert.equal((await checkUpstream(hubEnv, request)).needed, false);
  const probes = calls.filter(({ url }) => url.includes('registry-1.docker.io'));
  assert.deepEqual(probes.map(({ url }) => url.split('/').at(-1)), [`sha-${sha}`, 'v1', 'latest']);
  assert.ok(probes.every(({ options }) => options.method === 'HEAD'));
});

test('partial mirror copies and mismatched digests request repair without needing a new release', async () => {
  for (const options of [{ hubMissing: `sha-${sha}` }, { hubMissing: 'v1' }, { hubMissing: 'latest' },
    { hubDigest: 'sha256:old' }]) {
    const result = await checkUpstream(hubEnv, mock(options).request);
    assert.equal(result.needed, true);
    assert.match(result.reason, /mirror needs repair/);
  }
});

test('API, registry and malformed responses fail instead of becoming a no-update result', async () => {
  for (const options of [{ hubStatus: 401 }, { hubStatus: 429 }, { hubStatus: 500 }, { hubDigest: '' }]) {
    await assert.rejects(checkUpstream(hubEnv, mock(options).request));
  }
  for (const failureUrl of ['/releases/', '/commits/', 'ghcr.io/token?', 'auth.docker.io/token?']) {
    const { request } = mock();
    await assert.rejects(checkUpstream(hubEnv, (url, options) =>
      url.includes(failureUrl) ? response({}, 403) : request(url, options)));
  }
});

test('historical lite releases probe only their own version and SHA aliases', async () => {
  const { request, calls } = mock();
  await checkUpstream({ ...hubEnv, FETCH_ASSETS: '0', REQUESTED_REF: 'v0' }, (url, options) =>
    url.endsWith('/releases/tags/v0') ? response({ tag_name: 'v0' }) : request(url, options));
  const manifests = calls.filter(({ url }) => url.includes('/manifests/')).map(({ url }) => url.split('/').at(-1));
  assert.deepEqual(manifests, ['v0-lite', `sha-${sha}-lite`, 'v0-lite']);
});

test('unreleased refs skip unchanged SHA images and request missing SHA images', async () => {
  for (const ghcrMissing of [false, true]) {
    const { request, calls } = mock({ release: false, ghcrMissing });
    assert.equal((await checkUpstream({ ...env, REQUESTED_REF: 'master' }, request)).needed, ghcrMissing);
    assert.ok(calls.some(({ url }) => url.endsWith(`/manifests/sha-${sha}`)));
    assert.ok(calls.every(({ url }) => !url.endsWith('/manifests/latest')));
  }
});

test('automatic dispatch rechecks publication but ordinary manual runs still force rebuilds', () => {
  const directory = mkdtempSync(join(tmpdir(), 'publication-check-'));
  try {
    for (const automatic of [false, true]) {
      const output = join(directory, `${automatic}.txt`);
      const script = `import { resolve } from 'node:path';
        globalThis.fetch = async (url) => new Response(JSON.stringify(
        url.includes('/token?') ? {token:'test'} : ${JSON.stringify(index)}),
        {headers:{'docker-content-digest':'sha256:complete'}});
        process.argv[1] = resolve('scripts/check-release-image.mjs');
        await import('./scripts/check-release-image.mjs');`;
      const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8',
        env: { ...process.env, GITHUB_EVENT_NAME: 'workflow_dispatch', CHECK_PUBLISHED: String(automatic),
          GITHUB_REPOSITORY: 'owner/game', VERSION_TAG: 'v1', LATEST_TAG: 'latest',
          REQUIRE_LOCAL_ASSETS: '1', GITHUB_OUTPUT: output, GITHUB_STEP_SUMMARY: '' } });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(readFileSync(output, 'utf8'), `build=${!automatic}\n`);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
