'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { configuration, handleSms, sendSms, smsIssueTitle } = require('./monitor-sms.cjs');
const { reconcile, checks } = require('./monitor-issues.cjs');

const context = {
  repo: { owner: 'bleudpart', repo: 'sirius' },
  serverUrl: 'https://github.com',
  runId: 123,
};
const env = {
  SIRIUS_SMS_ENABLED: '1',
  SIRIUS_SMS_ACCOUNT_SID: `AC${'1'.repeat(32)}`,
  SIRIUS_SMS_AUTH_TOKEN: 'synthetic-token',
  SIRIUS_SMS_FROM: 'SIRIUS',
  SIRIUS_SMS_TO: '+33123456789',
};
const accepted = async () => ({
  ok: true, status: 201,
  json: async () => ({ sid: `SM${'2'.repeat(32)}`, status: 'queued' }),
});

function harness(initial = []) {
  const issues = initial.map(issue => ({ ...issue }));
  const calls = [];
  let next = 100;
  const github = {
    paginate: async () => issues.filter(issue => issue.state !== 'closed'),
    rest: {
      issues: {
        listForRepo: async () => {},
        create: async options => {
          calls.push(['create', options]);
          const issue = { number: next++, ...options, state: 'open' };
          issues.push(issue);
          return { data: issue };
        },
        update: async options => {
          calls.push(['update', options]);
          const issue = issues.find(item => item.number === options.issue_number);
          assert.ok(issue);
          Object.assign(issue, options);
        },
        createComment: async options => calls.push(['comment', options]),
      },
    },
  };
  return { github, issues, calls };
}

test('requires a complete and valid configuration without leaking values', () => {
  assert.equal(configuration({}), null);
  assert.equal(configuration({ ...env, SIRIUS_SMS_ENABLED: '0' }), null);
  assert.throws(() => configuration({ SIRIUS_SMS_ENABLED: 'yes' }), /Activation SMS invalide/);
  assert.throws(() => configuration({
    SIRIUS_SMS_ENABLED: '1', SIRIUS_SMS_ACCOUNT_SID: env.SIRIUS_SMS_ACCOUNT_SID,
  }), /incomplète/);
  for (const invalid of [
    { ...env, SIRIUS_SMS_ACCOUNT_SID: 'bad' },
    { ...env, SIRIUS_SMS_TO: '0123456789' },
    { ...env, SIRIUS_SMS_FROM: '12345' },
  ]) {
    assert.throws(() => configuration(invalid), error => {
      assert.match(error.message, /invalide/);
      assert.ok(!error.message.includes(env.SIRIUS_SMS_AUTH_TOKEN));
      assert.ok(!error.message.includes(env.SIRIUS_SMS_TO));
      return true;
    });
  }
  assert.deepEqual(configuration(env), {
    sid: env.SIRIUS_SMS_ACCOUNT_SID,
    token: env.SIRIUS_SMS_AUTH_TOKEN,
    from: env.SIRIUS_SMS_FROM,
    to: env.SIRIUS_SMS_TO,
  });
});

test('sends one bounded message with form data and accepts a queued response', async () => {
  let request;
  await sendSms(configuration(env), ['api', 'backup'], false, async (url, options) => {
    request = { url, options };
    return accepted();
  });
  assert.match(request.url, /api\.twilio\.com\/2010-04-01\/Accounts\/AC/);
  assert.equal(request.options.method, 'POST');
  assert.match(request.options.headers.Authorization, /^Basic /);
  const form = new URLSearchParams(request.options.body);
  assert.equal(form.get('To'), env.SIRIUS_SMS_TO);
  assert.equal(form.get('From'), env.SIRIUS_SMS_FROM);
  assert.equal(form.get('Body'), 'SIRIUS alerte : API, sauvegarde. Voir GitHub.');
  assert.ok(form.get('Body').length < 160);
  assert.ok(!form.get('Body').includes(env.SIRIUS_SMS_AUTH_TOKEN));
});

test('does not expose provider errors or count an unconfirmed response as sent', async () => {
  await assert.rejects(
    sendSms(configuration(env), ['api'], false, async () => ({ ok: false, status: 401 })),
    /HTTP 401/,
  );
  await assert.rejects(
    sendSms(configuration(env), ['api'], false, async () => {
      throw new TypeError('synthetic-token and private phone');
    }),
    error => !error.message.includes('synthetic-token') && /Connexion/.test(error.message),
  );
  await assert.rejects(
    sendSms(configuration(env), ['api'], false, async () => ({
      ok: true, status: 201, json: async () => ({ sid: `SM${'2'.repeat(32)}`, status: 'failed' }),
    })),
    /pas confirmé/,
  );
});

test('disabled SMS leaves pending alerts untouched', async () => {
  const { github, issues, calls } = harness([
    { number: 1, check: 'api', body: '<!-- sirius-sms-attempts:0 -->' },
  ]);
  assert.deepEqual(await handleSms(github, context, issues, issues, {}), { enabled: false });
  assert.deepEqual(calls, []);
});

test('sends pending alerts once and does not repeat on later checks', async () => {
  const { github, issues, calls } = harness([
    { number: 1, check: 'api', body: 'API en panne.\n\n<!-- sirius-sms-attempts:0 -->' },
    { number: 2, check: 'backup', body: 'Sauvegarde en panne.' },
  ]);
  let count = 0;
  const fetch = async (...args) => { count += 1; return accepted(...args); };
  assert.deepEqual(await handleSms(github, context, issues, [], env, { fetch }), { enabled: true, sent: true });
  assert.equal(count, 1);
  assert.ok(issues.every(issue => issue.body.includes('<!-- sirius-sms-sent -->')));
  assert.deepEqual(await handleSms(github, context, issues, [], env, { fetch }), { enabled: true, sent: false });
  assert.equal(count, 1);
  assert.equal(calls.filter(([action]) => action === 'create').length, 0);
});

test('caps automatic failures at three and permits a deliberate paid manual test', async () => {
  const { github, issues, calls } = harness([
    { number: 1, check: 'api', body: '<!-- sirius-sms-attempts:0 -->' },
  ]);
  let requests = 0;
  const fail = async () => { requests += 1; throw new TypeError('private error'); };
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    await assert.rejects(handleSms(github, context, [issues[0]], issues, env, { fetch: fail }), /Connexion au service SMS impossible/);
    assert.match(issues[0].body, new RegExp(`sirius-sms-attempts:${attempt}`));
  }
  await assert.rejects(handleSms(github, context, [issues[0]], issues, env, { fetch: fail }), /Échec SMS/);
  assert.equal(requests, 3);
  assert.equal(calls.filter(([action, options]) => action === 'create' && options.title === smsIssueTitle).length, 1);

  const result = await handleSms(github, context, [issues[0]], issues, env, { test: true, fetch: accepted });
  assert.equal(result.sent, true);
  assert.match(issues[0].body, /sirius-sms-sent/);
  assert.equal(issues.find(issue => issue.title === smsIssueTitle).state, 'closed');
});

test('incomplete configuration opens one GitHub alert without a network request', async () => {
  const { github, issues, calls } = harness();
  const incomplete = { SIRIUS_SMS_ENABLED: '1', SIRIUS_SMS_ACCOUNT_SID: env.SIRIUS_SMS_ACCOUNT_SID };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await assert.rejects(handleSms(github, context, [], issues, incomplete), /incomplète/);
  }
  assert.equal(calls.filter(([action]) => action === 'create').length, 1);
  assert.equal(issues[0].title, smsIssueTitle);
});

test('issue lifecycle and SMS stay coordinated across outages and recovery', async () => {
  const { github, issues } = harness();
  const outcomes = {
    site: 'failure', api: 'success', disk: 'success', backup: 'failure',
    hostkey: 'success', deployment: 'success',
  };
  let state = await reconcile(github, context, outcomes);
  assert.equal(state.activeAlerts.length, 2);
  await handleSms(github, context, state.activeAlerts, state.openIssues, {});
  assert.equal(issues.length, 2);

  let requests = 0;
  const fetch = async (...args) => { requests += 1; return accepted(...args); };
  state = await reconcile(github, context, outcomes);
  await handleSms(github, context, state.activeAlerts, state.openIssues, env, { fetch });
  assert.equal(requests, 1);
  assert.ok(issues.every(issue => issue.body.includes('sirius-sms-sent')));

  state = await reconcile(github, context, outcomes);
  await handleSms(github, context, state.activeAlerts, state.openIssues, env, { fetch });
  assert.equal(requests, 1);

  state = await reconcile(github, context, { ...outcomes, site: 'success' });
  await handleSms(github, context, state.activeAlerts, state.openIssues, env, { fetch });
  assert.equal(issues.find(issue => issue.title === checks.site.title).state, 'closed');
  assert.equal(issues.find(issue => issue.title === checks.backup.title).state, 'open');

  state = await reconcile(github, context, outcomes);
  await handleSms(github, context, state.activeAlerts, state.openIssues, env, { fetch });
  assert.equal(requests, 2);
  assert.equal(issues.filter(issue => issue.title === checks.site.title).length, 2);
});

test('a failed deployment generates one SMS and remains open during a retry', async () => {
  const { github, issues } = harness();
  const outcomes = {
    site: 'success', api: 'success', disk: 'success', backup: 'success',
    hostkey: 'success', deployment: 'failure',
  };
  let state = await reconcile(github, context, outcomes);
  let message;
  const fetch = async (_url, options) => {
    message = new URLSearchParams(options.body).get('Body');
    return accepted();
  };
  await handleSms(github, context, state.activeAlerts, state.openIssues, env, { fetch });
  assert.equal(message, 'SIRIUS alerte : déploiement. Voir GitHub.');

  state = await reconcile(github, context, { ...outcomes, deployment: 'pending' });
  assert.equal(state.activeAlerts.length, 1);
  assert.equal(issues[0].state, 'open');
  assert.deepEqual(
    await handleSms(github, context, state.activeAlerts, state.openIssues, env, { fetch }),
    { enabled: true, sent: false },
  );
  await reconcile(github, context, { ...outcomes, deployment: 'success' });
  assert.equal(issues[0].state, 'closed');
});
