const REQUIRED_JOBS = ["audit", "windows-build", "integration-tests"];

function fixesKnownVulnerability(changes) {
  if (!Array.isArray(changes) || changes.length === 0) return false;

  const packages = new Map();
  for (const change of changes) {
    if (
      !change ||
      !["added", "removed"].includes(change.change_type) ||
      !["manifest", "ecosystem", "name"].every((key) => typeof change[key] === "string" && change[key]) ||
      !Array.isArray(change.vulnerabilities) ||
      change.vulnerabilities.some((advisory) =>
        !advisory || typeof advisory.advisory_ghsa_id !== "string" || !advisory.advisory_ghsa_id)
    ) {
      return false;
    }

    const key = JSON.stringify([change.manifest, change.ecosystem, change.name]);
    if (!packages.has(key)) packages.set(key, { added: new Set(), removed: new Set() });
    const advisories = packages.get(key)[change.change_type];
    for (const advisory of change.vulnerabilities) advisories.add(advisory.advisory_ghsa_id);
  }

  let fixed = false;
  for (const { added, removed } of packages.values()) {
    if ([...added].some((id) => !removed.has(id))) return false;
    if ([...removed].some((id) => !added.has(id))) fixed = true;
  }
  return fixed;
}

function requiresDeployment(files) {
  return files.some(({ filename }) =>
    /^(frontend|backend|deploy)\//.test(filename) ||
    filename === ".github/workflows/deploy-hetzner.yml");
}

function shouldMergeDependabotSecurityPr({
  run, jobs, pr, repository, defaultBranch, files, commit, baseSha, dependencyChanges,
}) {
  if (
    !run ||
    run.name !== "SIRIUS audit and release guard" ||
    run.event !== "pull_request" ||
    run.conclusion !== "success" ||
    !run.head_branch?.startsWith("dependabot/")
  ) {
    return false;
  }

  if (
    !pr ||
    pr.state !== "open" ||
    pr.draft ||
    pr.user?.login !== "dependabot[bot]" ||
    pr.base?.ref !== defaultBranch ||
    pr.head?.ref !== run.head_branch ||
    pr.head?.sha !== run.head_sha ||
    pr.head.repo?.full_name !== repository ||
    !Array.isArray(files) ||
    files.length === 0 ||
    !Array.isArray(jobs)
  ) {
    return false;
  }

  const testedPr = Array.isArray(run.pull_requests)
    ? run.pull_requests.find((candidate) => candidate.number === pr.number)
    : undefined;
  if (
    !baseSha ||
    testedPr?.base?.sha !== baseSha ||
    testedPr?.head?.sha !== run.head_sha ||
    commit?.sha !== run.head_sha ||
    commit.author?.login !== "dependabot[bot]" ||
    commit.commit?.verification?.verified !== true ||
    !fixesKnownVulnerability(dependencyChanges)
  ) {
    return false;
  }

  const requiredJobs = [...REQUIRED_JOBS];
  if (files.some(({ filename }) => /^(frontend|backend)\//.test(filename))) {
    requiredJobs.push("electron-build");
  }

  const successfulJobs = new Set(
    jobs.filter((job) => job.conclusion === "success").map((job) => job.name),
  );
  return requiredJobs.every((name) => successfulJobs.has(name));
}

async function processDependabotRun({ github, core, context }) {
  const run = context.payload.workflow_run;
  const { owner, repo } = context.repo;
  const defaultBranch = context.payload.repository.default_branch;
  const pulls = await github.paginate(github.rest.pulls.list, {
    owner,
    repo,
    state: "open",
    head: `${owner}:${run.head_branch}`,
    per_page: 100,
  });
  const pull = pulls.find((candidate) =>
    candidate.user?.login === "dependabot[bot]" && candidate.head?.sha === run.head_sha);
  if (!pull) {
    core.info("No open Dependabot pull request matches this tested commit.");
    return;
  }

  const [jobs, files, { data: commit }, { data: branch }] = await Promise.all([
    github.paginate(github.rest.actions.listJobsForWorkflowRun, {
      owner,
      repo,
      run_id: run.id,
      per_page: 100,
    }),
    github.paginate(github.rest.pulls.listFiles, {
      owner,
      repo,
      pull_number: pull.number,
      per_page: 100,
    }),
    github.rest.repos.getCommit({ owner, repo, ref: run.head_sha }),
    github.rest.repos.getBranch({ owner, repo, branch: defaultBranch }),
  ]);
  const testedPr = Array.isArray(run.pull_requests)
    ? run.pull_requests.find((candidate) => candidate.number === pull.number)
    : undefined;
  if (!testedPr || testedPr.base?.sha !== branch.commit.sha) {
    core.warning(`PR #${pull.number}: the tested base is no longer current; no merge.`);
    return;
  }

  const { data: dependencyChanges } = await github.request(
    "GET /repos/{owner}/{repo}/dependency-graph/compare/{basehead}",
    { owner, repo, basehead: `${branch.commit.sha}...${run.head_sha}` },
  );
  if (!shouldMergeDependabotSecurityPr({
    run,
    jobs,
    pr: pull,
    repository: `${owner}/${repo}`,
    defaultBranch,
    files,
    commit,
    baseSha: branch.commit.sha,
    dependencyChanges,
  })) {
    core.info(`PR #${pull.number} has no eligible, fully validated security fix.`);
    return;
  }

  const { data: latestBase } = await github.rest.repos.getBranch({
    owner,
    repo,
    branch: defaultBranch,
  });
  if (latestBase.commit.sha !== branch.commit.sha) {
    core.warning(`PR #${pull.number}: the base changed before merging; no merge.`);
    return;
  }

  const result = await github.rest.pulls.merge({
    owner,
    repo,
    pull_number: pull.number,
    merge_method: "squash",
    sha: run.head_sha,
  });
  if (!result.data.merged) throw new Error(`GitHub did not merge PR #${pull.number}.`);
  core.info(`Merged validated security update PR #${pull.number}.`);
  if (requiresDeployment(files)) {
    await github.rest.actions.createWorkflowDispatch({
      owner,
      repo,
      workflow_id: "deploy-hetzner.yml",
      ref: defaultBranch,
    });
    core.info("Dispatched the Hetzner deployment for the merged security fix.");
  }
}

module.exports = {
  fixesKnownVulnerability,
  processDependabotRun,
  requiresDeployment,
  shouldMergeDependabotSecurityPr,
};
