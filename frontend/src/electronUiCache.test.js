const fs = require("fs");
const os = require("os");
const path = require("path");
const { refreshUiCacheOnBuildChange, MARKER_FILE } = require("../public/electron/ui_cache");

let dir;
let indexPath;
let session;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "sirius-ui-cache-"));
  indexPath = path.join(dir, "index.html");
  fs.writeFileSync(indexPath, '<link href="/static/css/main.aaaa.css">');
  session = { clearCache: jest.fn().mockResolvedValue(), clearStorageData: jest.fn().mockResolvedValue() };
});

afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

test("clears the HTTP cache and service worker once per bundled interface build", async () => {
  const refresh = () => refreshUiCacheOnBuildChange({ session, indexPath, userDataPath: dir });

  await expect(refresh()).resolves.toBe(true);
  expect(session.clearCache).toHaveBeenCalledTimes(1);
  expect(session.clearStorageData).toHaveBeenCalledWith({ storages: ["serviceworkers", "cachestorage"] });
  expect(fs.existsSync(path.join(dir, MARKER_FILE))).toBe(true);

  await expect(refresh()).resolves.toBe(false);
  expect(session.clearCache).toHaveBeenCalledTimes(1);

  fs.writeFileSync(indexPath, '<link href="/static/css/main.bbbb.css">');
  await expect(refresh()).resolves.toBe(true);
  expect(session.clearCache).toHaveBeenCalledTimes(2);
});

test("leaves the cache alone when the bundled interface is missing", async () => {
  await expect(refreshUiCacheOnBuildChange({ session, indexPath: path.join(dir, "absent.html"), userDataPath: dir }))
    .resolves.toBe(false);
  expect(session.clearCache).not.toHaveBeenCalled();
});
