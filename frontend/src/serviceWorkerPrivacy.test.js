const fs = require("fs");
const path = require("path");
const vm = require("vm");

test.each(["confidentialite.html", "suppression-compte.html"])("standalone %s navigation bypasses the application shell cache", (filename) => {
  const listeners = {};
  const fetch = jest.fn().mockResolvedValue({ clone: () => ({}) });
  const put = jest.fn();
  const caches = { open: jest.fn().mockResolvedValue({ put }) };
  const self = { addEventListener: (name, handler) => { listeners[name] = handler; } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../public/sw.js"), "utf8"), {
    self, fetch, caches, URL,
  });
  const respondWith = jest.fn();
  listeners.fetch({
    request: { method: "GET", mode: "navigate", url: `https://sirius-assistant.fr/${filename}?test=1` },
    respondWith,
  });
  expect(respondWith).not.toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalled();
  expect(caches.open).not.toHaveBeenCalled();

  listeners.fetch({
    request: { method: "GET", mode: "navigate", url: "https://sirius-assistant.fr/" },
    respondWith,
  });
  expect(respondWith).toHaveBeenCalledTimes(1);
  expect(fetch).toHaveBeenCalledTimes(1);
});
