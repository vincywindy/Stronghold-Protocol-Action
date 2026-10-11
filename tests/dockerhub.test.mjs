import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { dockerhubConfig, mirrorToDockerhub } from '../scripts/dockerhub.mjs';

const env = { DOCKERHUB_USERNAME: 'example', DOCKERHUB_TOKEN: 'test-only-token',
  GITHUB_REPOSITORY: 'Owner/Stronghold-Protocol-Action' };

test('absent or partial Docker Hub credentials disable optional publishing', () => {
  for (const patch of [{ DOCKERHUB_USERNAME: '' }, { DOCKERHUB_TOKEN: '' },
    { DOCKERHUB_USERNAME: '', DOCKERHUB_TOKEN: '' }]) {
    assert.deepEqual(dockerhubConfig({ ...env, ...patch, DOCKERHUB_REPOSITORY: 'invalid' }), { enabled: false });
  }
});

test('Docker Hub supports the default personal repo and explicit organization repo', () => {
  assert.deepEqual(dockerhubConfig(env), { enabled: true, repository: 'example/stronghold-protocol-action' });
  assert.equal(dockerhubConfig({ ...env, DOCKERHUB_REPOSITORY: 'my-org/game' }).repository, 'my-org/game');
  for (const repository of ['docker.io/example/game', 'example/game:latest', 'Example/game', 'example/game\nx=1']) {
    assert.throws(() => dockerhubConfig({ ...env, DOCKERHUB_REPOSITORY: repository }));
  }
});

const raw = JSON.stringify({ manifests: ['amd64', 'arm64', 'unknown'].map((architecture) =>
  ({ platform: { os: architecture === 'unknown' ? 'unknown' : 'linux', architecture } })) });
const digest = `sha256:${createHash('sha256').update(raw).digest('hex')}`;
const options = { sourceImage: 'ghcr.io/owner/game', sourceTag: 'v0.2.1', repository: 'example/game',
  tags: ['ghcr.io/owner/game:sha-abc', 'ghcr.io/owner/game:v0.2.1', 'ghcr.io/owner/game:latest'] };

test('new/missing tags copy every architecture from one pinned digest then verify it', () => {
  const copies = [];
  const messages = [];
  const stored = new Map([['docker://docker.io/example/game:latest', '{}']]);
  const published = mirrorToDockerhub(options, (args) => {
    if (args[0] === 'copy') { copies.push(args); stored.set(args.at(-1), raw); return ''; }
    if (args.at(-1) === 'docker://ghcr.io/owner/game:v0.2.1') return raw;
    if (!stored.has(args.at(-1))) {
      throw Object.assign(new Error('Command failed'), { stderr: 'level=fatal msg="manifest unknown"' });
    }
    return stored.get(args.at(-1));
  }, (message) => messages.push(message));
  assert.equal(published.length, 3);
  assert.equal(copies.length, 3);
  assert.equal(messages.filter((message) => message.startsWith('Tag does not exist yet')).length, 2);
  assert.equal(messages.filter((message) => message.startsWith('Published and verified')).length, 3);
  assert.ok(messages.every((message) => !message.includes('fatal')));
  for (const args of copies) {
    assert.ok(args.includes('--all'));
    assert.ok(args.includes('--preserve-digests'));
    assert.equal(args.at(-2), `docker://ghcr.io/owner/game@${digest}`);
  }
});

test('already synchronized tags do not copy again on scheduled runs', () => {
  const messages = [];
  mirrorToDockerhub(options, (args) => { assert.equal(args[0], 'inspect'); return raw; }, (message) => messages.push(message));
  assert.equal(messages.length, 3);
  assert.ok(messages.every((message) => message.startsWith('Already synchronized')));
});

test('authentication and network failures are not treated as missing tags', () => {
  for (const stderr of ['unauthorized: authentication required', 'denied: requested access', 'TLS handshake timeout', 'toomanyrequests']) {
    const failure = Object.assign(new Error('Command failed'), { stderr });
    assert.throws(() => mirrorToDockerhub(options, (args) => {
      assert.equal(args[0], 'inspect');
      if (args.at(-1).includes('ghcr.io')) return raw;
      throw failure;
    }), (error) => error === failure);
  }
});

test('lite and historical tags retain their names without inventing latest', () => {
  const published = mirrorToDockerhub({ ...options, sourceTag: 'v0.1.4-lite',
    tags: ['ghcr.io/owner/game:v0.1.4-lite'] }, () => raw);
  assert.deepEqual(published, ['docker.io/example/game:v0.1.4-lite']);
});

test('incomplete source, copy failure and digest mismatch fail publication', () => {
  assert.throws(() => mirrorToDockerhub(options, () => '{}'), /multi-platform/);
  for (const copyFails of [true, false]) {
    assert.throws(() => mirrorToDockerhub(options, (args) => {
      if (args[0] === 'copy' && copyFails) throw new Error('denied');
      return args.at(-1).includes('ghcr.io') ? raw : '{}';
    }), copyFails ? /denied/ : /Digest mismatch/);
  }
});
