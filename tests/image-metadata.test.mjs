import assert from 'node:assert/strict';
import test from 'node:test';
import { imageMetadata } from '../scripts/image-metadata.mjs';

const base = {
  GITHUB_REPOSITORY: 'Example/Stronghold-Protocol-Action',
  UPSTREAM_SHA: 'a'.repeat(40),
  FETCH_ASSETS: '1',
  GITHUB_EVENT_NAME: 'schedule',
  GITHUB_REF: 'refs/heads/main',
  DEFAULT_BRANCH: 'main',
  RELEASE_TAG: 'v0.2.1',
  IS_LATEST_RELEASE: 'true',
  GITHUB_RUN_ID: '123',
  GITHUB_RUN_ATTEMPT: '2',
};

test('scheduled tracked builds publish lowercase GHCR tags', () => {
  const result = imageMetadata(base);
  assert.equal(result.publish, true);
  assert.deepEqual(result.tags, [
    `ghcr.io/example/stronghold-protocol-action:sha-${base.UPSTREAM_SHA}`,
    'ghcr.io/example/stronghold-protocol-action:v0.2.1',
    'ghcr.io/example/stronghold-protocol-action:latest',
  ]);
});

test('lite builds cannot overwrite asset-inclusive tags', () => {
  const result = imageMetadata({ ...base, FETCH_ASSETS: '0' });
  assert.ok(result.tags.every((tag) => tag.endsWith('-lite')));
});

test('automatic historical releases get their own version but never advance latest', () => {
  const result = imageMetadata({ ...base, GITHUB_EVENT_NAME: 'workflow_dispatch', AUTOMATED_BUILD: 'true', RELEASE_TAG: 'v0.1.4', IS_LATEST_RELEASE: 'false' });
  assert.equal(result.publish, true);
  assert.equal(result.tags.length, 2);
  assert.equal(result.tags[1], 'ghcr.io/example/stronghold-protocol-action:v0.1.4');
});

test('every human build is isolated from latest, release and upstream-SHA tags', () => {
  for (const FETCH_ASSETS of ['0', '1']) {
    const result = imageMetadata({ ...base, GITHUB_EVENT_NAME: 'workflow_dispatch', FETCH_ASSETS });
    assert.deepEqual(result.tags, [`${result.image}:manual-123-2${FETCH_ASSETS === '0' ? '-lite' : ''}`]);
    assert.equal(result.latestTag, '');
  }
});

test('manual plugin builds require explicit custom tags and publish that tag only', () => {
  const manual = { ...base, GITHUB_EVENT_NAME: 'workflow_dispatch', SELECTED_PLUGINS: 'forge,lele' };
  assert.throws(() => imageMetadata(manual), /explicit image_tag/);
  const result = imageMetadata({ ...manual, IMAGE_TAG: 'friends-031' });
  assert.deepEqual(result.tags, [`${result.image}:friends-031`]);
  assert.equal(result.latestTag, '');
  assert.equal(result.checkTag, 'friends-031');
  assert.throws(() => imageMetadata({ ...manual, AUTOMATED_BUILD: 'true', IMAGE_TAG: 'friends' }), /manual build/);
  assert.throws(() => imageMetadata({ ...manual, GITHUB_EVENT_NAME: 'push', IMAGE_TAG: 'friends' }), /manual build/);
});

test('manual tags cannot collide with automatic publication namespaces or inject output', () => {
  for (const IMAGE_TAG of ['latest', 'latest-lite', 'LATEST', 'sha-abc', 'v0.3.1', '0.3.1-lite', 'bad/tag', 'bad\nvalue', '-bad', 'a'.repeat(129)]) {
    assert.throws(() => imageMetadata({ ...base, GITHUB_EVENT_NAME: 'workflow_dispatch', IMAGE_TAG }));
  }
  assert.throws(() => imageMetadata({ ...base, IMAGE_TAG: 'custom' }), /only allowed/);
});

test('pushes and polls with sources retain automatic aliases, including manually triggered polls', () => {
  for (const mode of [{ GITHUB_EVENT_NAME: 'push' }, { GITHUB_EVENT_NAME: 'schedule' },
    { GITHUB_EVENT_NAME: 'workflow_dispatch', AUTOMATED_BUILD: 'true' }]) {
    assert.deepEqual(imageMetadata({ ...base, ...mode, SELECTED_PLUGINS: 'forge,lele' }).tags, imageMetadata(base).tags);
  }
});

test('unreleased branches get only a SHA tag', () => {
  const result = imageMetadata({ ...base, RELEASE_TAG: '', IS_LATEST_RELEASE: 'false' });
  assert.equal(result.tags.length, 1);
  assert.equal(result.versionTag, '');
});

test('pull requests and nondefault branches never publish', () => {
  for (const patch of [
    { GITHUB_EVENT_NAME: 'pull_request' },
    { GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REF: 'refs/heads/feature' },
    { GITHUB_EVENT_NAME: 'push', GITHUB_REF: 'refs/tags/v1.0.0' },
  ]) assert.equal(imageMetadata({ ...base, ...patch }).publish, false);
});

test('a master default branch can publish', () => {
  assert.equal(imageMetadata({ ...base, GITHUB_REF: 'refs/heads/master', DEFAULT_BRANCH: 'master' }).publish, true);
});

test('invalid metadata fails before writing workflow outputs', () => {
  for (const patch of [
    { UPSTREAM_SHA: 'abc\ninjected=value' },
    { GITHUB_REPOSITORY: 'owner/repo\ninjected=value' },
    { FETCH_ASSETS: 'true' },
    { RELEASE_TAG: 'release/v1' },
    { RELEASE_TAG: 'latest' },
  ]) assert.throws(() => imageMetadata({ ...base, ...patch }));
});
