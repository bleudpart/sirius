'use strict';

const title = 'SIRIUS : audit des dépendances en échec';
const marker = '<!-- sirius-dependency-audit -->';

async function reconcile(github, context, outcomes) {
  const { owner, repo } = context.repo;
  const run = `${context.serverUrl}/${owner}/${repo}/actions/runs/${context.runId}`;
  const workflow = `${context.serverUrl}/${owner}/${repo}/actions/workflows/sirius-maintenance.yml`;
  const issues = await github.paginate(github.rest.issues.listForRepo, {
    owner, repo, state: 'open', per_page: 100,
  });
  const existing = issues.filter(issue =>
    !issue.pull_request &&
    issue.title === title &&
    issue.user?.login === 'github-actions[bot]' &&
    typeof issue.body === 'string' &&
    issue.body.includes(marker)
  );
  const healthy = outcomes.npm === 'success' && outcomes.python === 'success';

  if (!healthy && existing.length === 0) {
    await github.rest.issues.create({
      owner,
      repo,
      title,
      assignees: [owner],
      body: [
        marker,
        "L'audit npm ou Python a signalé des vulnérabilités ou n'a pas pu s'exécuter.",
        `- npm : ${outcomes.npm || 'inconnu'}`,
        `- Python : ${outcomes.python || 'inconnu'}`,
        '',
        `[Voir la première exécution](${run}) et les [audits suivants](${workflow}).`,
        "Vérifier les rapports et les propositions Dependabot avant toute fusion.",
      ].join('\n'),
    });
  } else if (healthy) {
    for (const issue of existing) {
      await github.rest.issues.createComment({
        owner,
        repo,
        issue_number: issue.number,
        body: `Les audits npm et Python sont de nouveau réussis. [Voir la vérification](${run}).`,
      });
      await github.rest.issues.update({ owner, repo, issue_number: issue.number, state: 'closed' });
    }
  }
}

module.exports = { marker, reconcile, title };
