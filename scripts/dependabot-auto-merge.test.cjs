const assert = require("node:assert/strict");
const test = require("node:test");
const {
  fixesKnownVulnerability,
  processDependabotRun,
  requiresDeployment,
  shouldMergeDependabotSecurityPr,
} = require("./dependabot-auto-merge.cjs");

const run = {
  name: "SIRIUS audit and release guard",
  event: "pull_request",
  conclusion: "success",
  head_branch: "dependabot/pip/backend/pillow-13.0.0",
  head_sha: "abc123",
  pull_requests: [{ number: 42, head: { sha: "abc123" }, base: { sha: "base123" } }],
};
const pr = {
  number: 42,
  state: "open",
  draft: false,
  user: { login: "dependabot[bot]" },
  body: "Dependabot security fix",
  base: { ref: "master" },
  head: { ref: run.head_branch, sha: run.head_sha, repo: { full_name: "bleudpart/sirius" } },
};
const commit = {
  sha: run.head_sha,
  author: { login: "dependabot[bot]" },
  commit: { verification: { verified: true } },
};
const jobs = [
  { name: "audit", conclusion: "success" },
  { name: "windows-build", conclusion: "success" },
  { name: "integration-tests", conclusion: "success" },
  { name: "electron-build", conclusion: "success" },
];
const dependencyChanges = [
  {
    change_type: "removed",
    manifest: "backend/requirements.txt",
    ecosystem: "pip",
    name: "pillow",
    vulnerabilities: [{ advisory_ghsa_id: "GHSA-old" }],
  },
  {
    change_type: "added",
    manifest: "backend/requirements.txt",
    ecosystem: "pip",
    name: "pillow",
    vulnerabilities: [],
  },
];
const eligible = {
  run,
  jobs,
  pr,
  repository: "bleudpart/sirius",
  defaultBranch: "master",
  files: [{ filename: "backend/requirements.txt" }],
  commit,
  baseSha: "base123",
  dependencyChanges,
};

test("merges a security update only after all app dependency checks pass", () => {
  assert.equal(shouldMergeDependabotSecurityPr(eligible), true);
});

test("does not merge when an app dependency update did not build its installer", () => {
  assert.equal(
    shouldMergeDependabotSecurityPr({
      ...eligible,
      jobs: jobs.filter(({ name }) => name !== "electron-build"),
      files: [{ filename: "frontend/package-lock.json" }],
    }),
    false,
  );
});

test("does not merge ordinary dependency updates", () => {
  assert.equal(
    shouldMergeDependabotSecurityPr({
      ...eligible,
      pr: { ...pr, body: "update-type: security-update:semver-patch" },
      dependencyChanges: [],
    }),
    false,
  );
});

test("does not merge failed or stale workflow runs", () => {
  assert.equal(
    shouldMergeDependabotSecurityPr({
      ...eligible,
      run: { ...run, conclusion: "failure" },
    }),
    false,
  );
  assert.equal(
    shouldMergeDependabotSecurityPr({
      ...eligible,
      pr: { ...pr, head: { ...pr.head, sha: "newer-sha" } },
    }),
    false,
  );
  assert.equal(
    shouldMergeDependabotSecurityPr({ ...eligible, baseSha: "newer-base" }),
    false,
  );
});

test("requires a verified Dependabot commit matching the tested head", () => {
  assert.equal(
    shouldMergeDependabotSecurityPr({
      ...eligible,
      commit: { ...commit, author: { login: "someone-else" } },
    }),
    false,
  );
  assert.equal(
    shouldMergeDependabotSecurityPr({
      ...eligible,
      commit: { ...commit, commit: { verification: { verified: false } } },
    }),
    false,
  );
});

test("refuses unresolved or newly introduced vulnerability advisories", () => {
  const stillVulnerable = [
    dependencyChanges[0],
    { ...dependencyChanges[1], vulnerabilities: [{ advisory_ghsa_id: "GHSA-old" }] },
  ];
  assert.equal(fixesKnownVulnerability(stillVulnerable), false);
  assert.equal(
    fixesKnownVulnerability([
      ...dependencyChanges,
      {
        change_type: "added",
        manifest: "backend/requirements.txt",
        ecosystem: "pip",
        name: "new-dependency",
        vulnerabilities: [{ advisory_ghsa_id: "GHSA-new" }],
      },
    ]),
    false,
  );
  assert.equal(fixesKnownVulnerability([{ ...dependencyChanges[0], vulnerabilities: null }]), false);
});

test("recognizes removals and compares advisories within each manifest and package", () => {
  assert.equal(fixesKnownVulnerability([dependencyChanges[0]]), true);
  assert.equal(
    fixesKnownVulnerability([
      dependencyChanges[0],
      { ...dependencyChanges[1], name: "another-package", vulnerabilities: [{ advisory_ghsa_id: "GHSA-old" }] },
    ]),
    false,
  );
});

test("dispatches deployment only for the existing Hetzner path filters", () => {
  for (const filename of [
    "frontend/package-lock.json",
    "backend/requirements.txt",
    "deploy/hetzner/deploy.sh",
    ".github/workflows/deploy-hetzner.yml",
  ]) {
    assert.equal(requiresDeployment([{ filename }]), true, filename);
  }
  assert.equal(
    requiresDeployment([
      { filename: "integrations/zapier/package-lock.json" },
      { filename: ".github/workflows/sirius-audit.yml" },
    ]),
    false,
  );
});

function fakeGitHub({ baseHeads = ["base123", "base123"], files = eligible.files, failRequest, failDispatch } = {}) {
  const calls = [];
  let branchCalls = 0;
  const github = {
    rest: {
      pulls: {
        list: async () => [pr],
        listFiles: async () => files,
        merge: async (args) => {
          calls.push({ method: "merge", args });
          return { data: { merged: true } };
        },
      },
      actions: {
        listJobsForWorkflowRun: async () => jobs,
        createWorkflowDispatch: async (args) => {
          calls.push({ method: "dispatch", args });
          if (failDispatch) throw new Error("deployment dispatch failed");
        },
      },
      repos: {
        getCommit: async () => ({ data: commit }),
        getBranch: async () => ({ data: { commit: { sha: baseHeads[branchCalls++] } } }),
      },
    },
    paginate: async (method, args) => method(args),
    request: async (route, args) => {
      calls.push({ method: "review", route, args });
      if (failRequest) throw new Error("dependency review unavailable");
      return { data: dependencyChanges };
    },
  };
  return { github, calls };
}

function fakeContext() {
  return {
    repo: { owner: "bleudpart", repo: "sirius" },
    payload: { workflow_run: { ...run, id: 123 }, repository: { default_branch: "master" } },
  };
}

function fakeCore() {
  return { info: () => {}, warning: () => {} };
}

test("reviews the tested commits, merges the exact head, and dispatches deployment", async () => {
  const { github, calls } = fakeGitHub();
  await processDependabotRun({ github, core: fakeCore(), context: fakeContext() });
  assert.deepEqual(calls.map(({ method }) => method), ["review", "merge", "dispatch"]);
  assert.equal(calls[0].args.basehead, "base123...abc123");
  assert.equal(calls[1].args.sha, "abc123");
  assert.equal(calls[2].args.workflow_id, "deploy-hetzner.yml");
  assert.equal(calls[2].args.ref, "master");
});

test("does not deploy integration-only changes", async () => {
  const { github, calls } = fakeGitHub({ files: [{ filename: "integrations/zapier/package-lock.json" }] });
  await processDependabotRun({ github, core: fakeCore(), context: fakeContext() });
  assert.deepEqual(calls.map(({ method }) => method), ["review", "merge"]);
});

test("does not merge if the base changes during validation", async () => {
  const { github, calls } = fakeGitHub({ baseHeads: ["base123", "newer-base"] });
  await processDependabotRun({ github, core: fakeCore(), context: fakeContext() });
  assert.deepEqual(calls.map(({ method }) => method), ["review"]);
});

test("surfaces API errors without pretending a review or deployment succeeded", async () => {
  const unavailable = fakeGitHub({ failRequest: true });
  await assert.rejects(
    processDependabotRun({ github: unavailable.github, core: fakeCore(), context: fakeContext() }),
    /dependency review unavailable/,
  );
  assert.deepEqual(unavailable.calls.map(({ method }) => method), ["review"]);

  const failedDeployment = fakeGitHub({ failDispatch: true });
  await assert.rejects(
    processDependabotRun({ github: failedDeployment.github, core: fakeCore(), context: fakeContext() }),
    /deployment dispatch failed/,
  );
  assert.deepEqual(failedDeployment.calls.map(({ method }) => method), ["review", "merge", "dispatch"]);
});
