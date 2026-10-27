const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { Readable } = require("node:stream");
const { parseRange, contentTypeForPath } = require("./range");

// Execute the actual protocol helper without booting an Electron app.
const source = fs.readFileSync(path.join(__dirname, "index.js"), "utf8");
const helper = source.slice(source.indexOf("function serveLocalFileWithRange("), source.indexOf("\nconst cfg ="));
function handler(acquireLocalRead) {
  return vm.runInNewContext(`${helper}; serveLocalFileWithRange`, {
    fs, Readable, Response, parseRange, contentTypeForPath,
    engine: { acquireLocalRead },
  });
}

test("fenced paths never open a playback stream", () => {
  assert.equal(handler(() => null)("/not-opened", null).status, 409);
});

test("missing and unsatisfiable files release playback leases", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "em-playback-"));
  try {
    let releases = 0;
    const serve = handler(() => () => { releases++; });
    assert.equal(serve(path.join(root, "missing"), null).status, 404);
    fs.writeFileSync(path.join(root, "video.mp4"), "abc");
    assert.equal(serve(path.join(root, "video.mp4"), "bytes=9-").status, 416);
    assert.equal(releases, 2);
  } finally { fs.rmSync(root, { recursive: true }); }
});

test("playback holds its lease until the actual range stream closes", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "em-playback-"));
  try {
    const file = path.join(root, "video.mp4");
    fs.writeFileSync(file, "abcdef");
    let released = false;
    const response = handler(() => () => { released = true; })(file, "bytes=1-3");
    assert.equal(response.status, 206);
    assert.equal(released, false);
    assert.equal(await response.text(), "bcd");
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(released, true);
  } finally { fs.rmSync(root, { recursive: true }); }
});