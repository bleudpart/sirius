'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { marker, reconcile, title } = require('./dependency-audit-alert.cjs');

const context = {
  repo: { owner: 'bleudpart', repo: 'sirius' },
  serverUrl: 'https://github.com',
  runId: 123,
};
const healthy = { npm: 'success', python: 'success' };

function harness(issues = []) {
  const calls = [];
  const github = {
    paginate: async (_method, options) => {
      calls.push(['list', options]);
      return issues;
    },
    rest: {
      issues: {
        listForRepo: async () => {},
        create: async options => calls.push(['create', options]),
        createComment: async options => calls.push(['comment', options]),
        update: async options => calls.push(['update', options]),
      },
    },
  };
  return { github, calls };
}

function alert(number, overrides = {}) {
  return {
    number,
    title,
    body: marker,
    user: { login: 'github-actions[bot]' },
    ...overrides,
  };
}

test('creates an assigned alert with the failing checks and run link', async () => {
  const { github, calls } = harness();
  await reconcile(github, context, { npm: 'failure', python: 'success' });
  const created = calls.find(([action]) => action === 'create')[1];
  assert.equal(created.title, title);
  assert.deepEqual(created.assignees, ['bleudpart']);
  assert.match(created.body, /npm : failure/);
  assert.match(created.body, /Python : success/);
  assert.match(created.body, /actions\/runs\/123/);
  assert.match(created.body, /actions\/workflows\/sirius-maintenance\.yml/);
  assert.ok(created.body.includes(marker));
});

test('does not duplicate an existing alert while a check still fails', async () => {
  const { github, calls } = harness([alert(10)]);
  await reconcile(github, context, { npm: 'success', python: 'failure' });
  assert.deepEqual(calls.map(([action]) => action), ['list']);
});

test('missing or skipped checks cannot close an alert', async () => {
  for (const outcomes of [{}, { npm: 'success', python: 'skipped' }]) {
    const { github, calls } = harness([alert(10)]);
    await reconcile(github, context, outcomes);
    assert.deepEqual(calls.map(([action]) => action), ['list']);
  }
});

test('closes only matching bot alerts after both checks pass', async () => {
  const { github, calls } = harness([
    alert(10),
    alert(11),
    alert(12, { pull_request: {} }),
    alert(13, { user: { login: 'someone-else' } }),
    alert(14, { body: 'Manually created issue' }),
    alert(15, { title: 'Unrelated issue' }),
  ]);
  await reconcile(github, context, healthy);
  const closed = calls.filter(([action]) => action === 'update').map(([, options]) => options);
  assert.deepEqual(closed.map(options => options.issue_number), [10, 11]);
  assert.ok(closed.every(options => options.state === 'closed'));
  assert.equal(calls.filter(([action]) => action === 'comment').length, 2);
});

test('does nothing when both checks pass and no alert exists', async () => {
  const { github, calls } = harness();
  await reconcile(github, context, healthy);
  assert.deepEqual(calls.map(([action]) => action), ['list']);
});

test('propagates GitHub API errors rather than reporting success', async () => {
  const { github } = harness();
  github.rest.issues.create = async () => { throw new Error('GitHub API unavailable'); };
  await assert.rejects(reconcile(github, context, {}), /GitHub API unavailable/);
});
