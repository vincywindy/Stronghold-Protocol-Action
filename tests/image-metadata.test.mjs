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

test('historical releases get their own version but never advance latest', () => {
  const result = imageMetadata({ ...base, GITHUB_EVENT_NAME: 'workflow_dispatch', RELEASE_TAG: 'v0.1.4', IS_LATEST_RELEASE: 'false' });
  assert.equal(result.publish, true);
  assert.equal(result.tags.length, 2);
  assert.equal(result.tags[1], 'ghcr.io/example/stronghold-protocol-action:v0.1.4');
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
