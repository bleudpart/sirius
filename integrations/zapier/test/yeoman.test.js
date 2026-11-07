const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const inquirer = require("inquirer");
const { createEnv } = require("zapier-platform-cli/src/utils/esm-wrapper");
const { ProjectGenerator, PullGenerator } = require("zapier-platform-cli/src/generators");

async function temporaryDirectory(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "sirius-zapier-test-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

test("the Zapier project generator supports interactive choices", async (t) => {
  const directory = await temporaryDirectory(t);
  const environment = await createEnv();
  const prompts = [];
  environment.adapter.prompt = async (questions) => {
    const answers = {};
    for (const question of questions) {
      prompts.push(question.name);
      if (question.name === "template") answers.template = "minimal";
      if (question.name === "module") answers.module = "commonjs";
    }
    return answers;
  };
  environment.registerStub(await ProjectGenerator, "zapier:integration");
  await environment.run("zapier:integration", { path: directory, language: "javascript" });
  assert.deepEqual(prompts, ["template", "module"]);
  const manifest = JSON.parse(await fs.readFile(path.join(directory, "package.json"), "utf8"));
  assert.equal(manifest.main, "index.js");
  await fs.access(path.join(directory, "index.js"));
});

test("the Zapier pull generator copies files after confirmation", async (t) => {
  const directory = await temporaryDirectory(t);
  const source = path.join(directory, "source");
  const destination = path.join(directory, "destination");
  await fs.mkdir(source);
  await fs.mkdir(destination);
  await fs.writeFile(path.join(source, "source.js"), "module.exports = 42;\n");
  const originalPrompt = inquirer.prompt;
  t.after(() => { inquirer.prompt = originalPrompt; });
  let confirmed = false;
  inquirer.prompt = async (questions) => {
    confirmed = questions.some((question) => question.name === "confirm");
    return { confirm: true };
  };
  const environment = await createEnv();
  environment.registerStub(await PullGenerator, "zapier:pull");
  await environment.run("zapier:pull", {
    srcDir: source, dstDir: destination, sourceFiles: ["source.js"],
  });
  assert.equal(confirmed, true);
  assert.equal(await fs.readFile(path.join(destination, "source.js"), "utf8"), "module.exports = 42;\n");
});
