'use strict';

const pendingStatuses = new Set(['queued', 'in_progress', 'requested', 'waiting', 'pending']);

async function latestDeployment(github, context) {
  const { owner, repo } = context.repo;
  const response = await github.rest.actions.listWorkflowRuns({
    owner,
    repo,
    workflow_id: 'deploy-hetzner.yml',
    branch: 'master',
    per_page: 1,
  });
  const runs = response.data && response.data.workflow_runs;
  if (!Array.isArray(runs) || runs.length === 0) {
    throw new Error('Dernier déploiement introuvable.');
  }
  const run = runs[0];
  if (pendingStatuses.has(run.status)) return 'pending';
  if (run.status !== 'completed' || typeof run.conclusion !== 'string') {
    throw new Error('État du dernier déploiement invalide.');
  }
  return run.conclusion === 'success' ? 'success' : 'failure';
}

module.exports = { latestDeployment };
