'use strict';

const smsIssueTitle = 'SIRIUS surveillance : envoi SMS';
const pendingMarker = /<!-- sirius-sms-attempts:(\d+) -->/;
const sentMarker = '<!-- sirius-sms-sent -->';
const maxAttempts = 3;
const labels = { site: 'site', api: 'API', disk: 'disque', backup: 'sauvegarde', hostkey: 'SSH' };

class SmsError extends Error {}

function configuration(env) {
  const enabled = (env.SIRIUS_SMS_ENABLED || '').trim();
  if (!enabled || enabled === '0') return null;
  if (enabled !== '1') throw new Error('Activation SMS invalide.');
  const sid = (env.SIRIUS_SMS_ACCOUNT_SID || '').trim();
  const token = (env.SIRIUS_SMS_AUTH_TOKEN || '').trim();
  const from = (env.SIRIUS_SMS_FROM || '').trim();
  const to = (env.SIRIUS_SMS_TO || '').trim();
  const values = [sid, token, from, to];
  if (values.some(value => !value)) throw new Error('Configuration SMS incomplète.');
  const phone = /^\+[1-9]\d{6,14}$/;
  const sender = /^[A-Za-z0-9]{1,11}$/;
  if (!/^AC[0-9a-f]{32}$/i.test(sid) || !phone.test(to)
      || !(phone.test(from) || (sender.test(from) && /[A-Za-z]/.test(from)))) {
    throw new Error('Configuration SMS invalide.');
  }
  return { sid, token, from, to };
}

async function sendSms(config, names, test, fetchImpl = globalThis.fetch) {
  const prefix = test ? 'SIRIUS test SMS' : 'SIRIUS alerte';
  const details = names.length ? ` : ${names.map(name => labels[name]).join(', ')}` : '';
  const payload = new URLSearchParams({
    To: config.to,
    From: config.from,
    Body: `${prefix}${details}. Voir GitHub.`,
  });
  let response;
  try {
    response = await fetchImpl(`https://api.twilio.com/2010-04-01/Accounts/${config.sid}/Messages.json`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${Buffer.from(`${config.sid}:${config.token}`).toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: payload.toString(),
      signal: AbortSignal.timeout(15000),
    });
  } catch (error) {
    if (error instanceof TypeError || error.name === 'AbortError' || error.name === 'TimeoutError') {
      throw new SmsError('Connexion au service SMS impossible.');
    }
    throw error;
  }
  if (!response.ok) throw new SmsError(`Le service SMS a refusé la demande (HTTP ${response.status}).`);
  let result;
  try {
    result = await response.json();
  } catch (error) {
    if (error instanceof SyntaxError || error instanceof TypeError) {
      throw new SmsError('Réponse du service SMS invalide.');
    }
    throw error;
  }
  if (!result || !/^SM[0-9a-f]{32}$/i.test(result.sid || '')
      || !['accepted', 'queued', 'sending', 'sent', 'delivered'].includes(result.status)) {
    throw new SmsError("Le service SMS n'a pas confirmé la prise en charge.");
  }
}

async function handleSms(github, context, activeAlerts, openIssues, env, options = {}) {
  const { owner, repo } = context.repo;
  const run = `${context.serverUrl}/${owner}/${repo}/actions/runs/${context.runId}`;
  let failureIssue = openIssues.find(issue => !issue.pull_request && issue.title === smsIssueTitle);

  async function reportFailure() {
    if (!failureIssue) {
      const created = await github.rest.issues.create({
        owner,
        repo,
        title: smsIssueTitle,
        body: `Un SMS n'a pas pu être préparé ou envoyé. Les alertes GitHub restent actives. Vérifier la configuration et le compte du prestataire. [Voir le contrôle](${run}).`,
        assignees: [owner],
      });
      failureIssue = created.data;
    }
  }

  let config;
  try {
    config = configuration(env);
  } catch (error) {
    await reportFailure();
    throw error;
  }
  if (!config) {
    if (options.test || failureIssue) {
      await reportFailure();
      throw new Error('SMS non configurés.');
    }
    return { enabled: false };
  }

  for (const issue of activeAlerts) {
    if (!(issue.body || '').match(pendingMarker) && !(issue.body || '').includes(sentMarker)) {
      const body = `${issue.body || ''}\n\n<!-- sirius-sms-attempts:0 -->`;
      await github.rest.issues.update({ owner, repo, issue_number: issue.number, body });
      issue.body = body;
    }
  }
  const pending = activeAlerts
    .map(issue => ({ issue, marker: (issue.body || '').match(pendingMarker) }))
    .filter(item => item.marker);
  const attempted = pending.filter(item => options.test || Number(item.marker[1]) < maxAttempts);
  if (!attempted.length && !options.test) {
    if (pending.length || failureIssue) {
      await reportFailure();
      throw new Error('Échec SMS à vérifier ; relancer un test manuel après correction.');
    }
    return { enabled: true, sent: false };
  }

  for (const item of attempted) {
    const body = item.issue.body.replace(pendingMarker, `<!-- sirius-sms-attempts:${Number(item.marker[1]) + 1} -->`);
    await github.rest.issues.update({ owner, repo, issue_number: item.issue.number, body });
    item.issue.body = body;
  }
  try {
    const names = [...new Set(attempted.map(item => item.issue.check))];
    await sendSms(config, names, Boolean(options.test), options.fetch);
  } catch (error) {
    await reportFailure();
    if (error instanceof SmsError) throw error;
    throw new Error('Envoi SMS impossible ; voir l’alerte GitHub.');
  }

  for (const item of attempted) {
    const body = item.issue.body.replace(pendingMarker, sentMarker);
    await github.rest.issues.update({ owner, repo, issue_number: item.issue.number, body });
    item.issue.body = body;
  }
  if (failureIssue) {
    await github.rest.issues.createComment({
      owner, repo, issue_number: failureIssue.number,
      body: `Le service SMS a accepté une nouvelle demande. [Voir le contrôle](${run}).`,
    });
    await github.rest.issues.update({ owner, repo, issue_number: failureIssue.number, state: 'closed' });
  }
  return { enabled: true, sent: true };
}

module.exports = { configuration, handleSms, sendSms, smsIssueTitle };
