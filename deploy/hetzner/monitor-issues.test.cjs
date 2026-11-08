'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { checks, reconcile } = require('./monitor-issues.cjs');

const context = {
  repo: { owner: 'bleudpart', repo: 'sirius' },
  serverUrl: 'https://github.com',
  runId: 123,
};
const healthy = {
  site: 'success', api: 'success', disk: 'success', backup: 'success',
  hostkey: 'success', deployment: 'success',
};

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
        create: async options => {
          calls.push(['create', options]);
          return { data: { number: calls.length + 100, ...options } };
        },
        createComment: async options => calls.push(['comment', options]),
        update: async options => calls.push(['update', options]),
      },
    },
  };
  return { github, calls };
}

test('creates separate, assigned alerts for each failure', async () => {
  const { github, calls } = harness();
  await reconcile(github, context, { ...healthy, site: 'failure', backup: 'failure' });
  const created = calls.filter(([action]) => action === 'create').map(([, options]) => options);
  assert.deepEqual(created.map(issue => issue.title), [checks.site.title, checks.backup.title]);
  assert.deepEqual(created[0].assignees, ['bleudpart']);
  assert.match(created[0].body, /actions\/runs\/123/);
});

test('avoids repeated notifications and does not let a backup alert mask an API alert', async () => {
  const { github, calls } = harness([{ number: 10, title: checks.backup.title }]);
  await reconcile(github, context, { ...healthy, api: 'failure', backup: 'failure' });
  const created = calls.filter(([action]) => action === 'create').map(([, options]) => options);
  assert.deepEqual(created.map(issue => issue.title), [checks.api.title]);
  assert.equal(calls.filter(([action]) => action === 'comment').length, 0);
});

test('closes only recovered alert issues, including duplicates', async () => {
  const { github, calls } = harness([
    { number: 10, title: checks.api.title },
    { number: 11, title: checks.api.title },
    { number: 12, title: checks.backup.title },
    { number: 13, title: checks.api.title, pull_request: {} },
    { number: 14, title: 'Unrelated issue' },
  ]);
  await reconcile(github, context, { ...healthy, backup: 'failure' });
  const closed = calls.filter(([action]) => action === 'update').map(([, options]) => options.issue_number);
  assert.deepEqual(closed, [10, 11]);
  assert.equal(calls.filter(([action]) => action === 'comment').length, 2);
  assert.equal(calls.filter(([action]) => action === 'create').length, 0);
});

test('missing outcomes are treated as failures, not successes', async () => {
  const { github, calls } = harness();
  await reconcile(github, context, {});
  assert.equal(calls.filter(([action]) => action === 'create').length, 6);
});

test('blocked checks do not create or close alerts when the SSH host key is unverified', async () => {
  const { github, calls } = harness([
    { number: 10, title: checks.disk.title },
    { number: 11, title: checks.backup.title },
  ]);
  const state = await reconcile(github, context, {
    ...healthy, hostkey: 'failure', disk: 'blocked', backup: 'blocked',
  });
  assert.deepEqual(
    calls.filter(([action, options]) => action === 'create').map(([, options]) => options.title),
    [checks.hostkey.title],
  );
  assert.equal(calls.filter(([action]) => action === 'update').length, 0);
  assert.equal(calls.filter(([action]) => action === 'comment').length, 0);
  assert.deepEqual(state.activeAlerts.map(issue => issue.check), ['hostkey']);
});

test('opens a failed deployment alert and closes it only after a successful deployment', async () => {
  let state = harness();
  await reconcile(state.github, context, { ...healthy, deployment: 'failure' });
  assert.deepEqual(
    state.calls.filter(([action]) => action === 'create').map(([, options]) => options.title),
    [checks.deployment.title],
  );

  state = harness([{ number: 10, title: checks.deployment.title }]);
  const pending = await reconcile(state.github, context, { ...healthy, deployment: 'pending' });
  assert.deepEqual(pending.activeAlerts.map(issue => issue.number), [10]);
  assert.equal(state.calls.filter(([action]) => action === 'update').length, 0);

  state = harness([{ number: 10, title: checks.deployment.title }]);
  await reconcile(state.github, context, healthy);
  assert.deepEqual(
    state.calls.filter(([action]) => action === 'update').map(([, options]) => options.issue_number),
    [10],
  );
});

test('does not open a deployment alert while a new deployment is pending', async () => {
  const { github, calls } = harness();
  await reconcile(github, context, { ...healthy, deployment: 'pending' });
  assert.equal(calls.filter(([action]) => action === 'create').length, 0);
});
