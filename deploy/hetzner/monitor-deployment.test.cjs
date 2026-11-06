'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { latestDeployment } = require('./monitor-deployment.cjs');

const context = { repo: { owner: 'bleudpart', repo: 'sirius' } };

function harness(workflowRuns) {
  const calls = [];
  return {
    calls,
    github: {
      rest: {
        actions: {
          listWorkflowRuns: async options => {
            calls.push(options);
            return { data: { workflow_runs: workflowRuns } };
          },
        },
      },
    },
  };
}

test('reads the newest master deployment and distinguishes its conclusion', async () => {
  const { github, calls } = harness([{ status: 'completed', conclusion: 'success' }]);
  assert.equal(await latestDeployment(github, context), 'success');
  assert.deepEqual(calls, [{
    owner: 'bleudpart', repo: 'sirius', workflow_id: 'deploy-hetzner.yml',
    branch: 'master', per_page: 1,
  }]);

  for (const conclusion of ['failure', 'timed_out', 'cancelled', 'skipped']) {
    const failed = harness([{ status: 'completed', conclusion }]);
    assert.equal(await latestDeployment(failed.github, context), 'failure');
  }
});

test('does not declare a deployment healthy or failed while it is running', async () => {
  for (const status of ['queued', 'in_progress', 'requested', 'waiting', 'pending']) {
    const { github } = harness([{ status, conclusion: null }]);
    assert.equal(await latestDeployment(github, context), 'pending');
  }
});

test('reports missing, invalid, and inaccessible deployment status explicitly', async () => {
  for (const runs of [[], null, [{ status: 'unexpected', conclusion: 'success' }], [{ status: 'completed', conclusion: null }]]) {
    const { github } = harness(runs);
    await assert.rejects(latestDeployment(github, context), /déploiement/);
  }
  const github = {
    rest: { actions: { listWorkflowRuns: async () => { throw new Error('API inaccessible'); } } },
  };
  await assert.rejects(latestDeployment(github, context), /API inaccessible/);
});
