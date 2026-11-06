'use strict';

const checks = {
  site: {
    title: 'SIRIUS surveillance : site',
    description: 'Le site ne répond pas normalement ou sa version publiée est invalide.',
  },
  api: {
    title: 'SIRIUS surveillance : API et base MongoDB',
    description: "L'API, son contrôle de santé ou la base MongoDB attendue ne répond pas normalement.",
  },
  disk: {
    title: 'SIRIUS surveillance : espace disque',
    description: "L'espace disque est insuffisant ou n'a pas pu être vérifié sur le serveur.",
  },
  backup: {
    title: 'SIRIUS surveillance : sauvegarde',
    description: "La sauvegarde est absente, trop ancienne, en échec ou n'a pas pu être vérifiée.",
  },
  hostkey: {
    title: 'SIRIUS surveillance : identité SSH du serveur',
    description: "L'empreinte SSH vérifiée du serveur n'est pas configurée dans GitHub.",
  },
  deployment: {
    title: 'SIRIUS surveillance : déploiement',
    description: "Le dernier déploiement a échoué ou son résultat n'a pas pu être vérifié.",
  },
};
const smsPending = '<!-- sirius-sms-attempts:0 -->';

async function reconcile(github, context, outcomes) {
  const { owner, repo } = context.repo;
  const run = `${context.serverUrl}/${owner}/${repo}/actions/runs/${context.runId}`;
  const openIssues = await github.paginate(github.rest.issues.listForRepo, {
    owner, repo, state: 'open', per_page: 100,
  });
  const activeAlerts = [];

  for (const [name, check] of Object.entries(checks)) {
    const existing = openIssues.filter(issue => !issue.pull_request && issue.title === check.title);
    if (name === 'deployment' && outcomes[name] === 'pending') {
      activeAlerts.push(...existing.map(issue => ({ ...issue, check: name })));
      continue;
    }
    if (outcomes[name] !== 'success') {
      if (existing.length === 0) {
        const created = await github.rest.issues.create({
          owner,
          repo,
          title: check.title,
          body: `${check.description}\n\nLa surveillance elle-même peut aussi être en panne. [Voir le contrôle](${run}).\n\n${smsPending}`,
          assignees: [owner],
        });
        activeAlerts.push({ ...created.data, check: name });
      } else {
        activeAlerts.push(...existing.map(issue => ({ ...issue, check: name })));
      }
    } else {
      for (const issue of existing) {
        await github.rest.issues.createComment({
          owner, repo, issue_number: issue.number,
          body: `Le contrôle est de nouveau réussi. [Voir la vérification](${run}).`,
        });
        await github.rest.issues.update({ owner, repo, issue_number: issue.number, state: 'closed' });
      }
    }
  }
  return { openIssues, activeAlerts };
}

module.exports = { checks, reconcile };
