// Unit tests for the em-proxy:// Range parser. Run with: node --test
const test = require("node:test");
const assert = require("node:assert/strict");
const { parseRange, contentTypeForPath } = require("./range");

test("no range header -> full file", () => {
  assert.deepEqual(parseRange(1000, undefined), { kind: "full" });
  assert.deepEqual(parseRange(1000, null), { kind: "full" });
  assert.deepEqual(parseRange(1000, ""), { kind: "full" });
});

test("non-bytes / malformed range -> full file", () => {
  assert.deepEqual(parseRange(1000, "items=0-10"), { kind: "full" });
  assert.deepEqual(parseRange(1000, "bytes=-"), { kind: "full" });
  assert.deepEqual(parseRange(1000, "garbage"), { kind: "full" });
});

test("open-ended range bytes=0- serves to end", () => {
  assert.deepEqual(parseRange(1000, "bytes=0-"), {
    kind: "range",
    start: 0,
    end: 999,
  });
});

test("explicit closed range is inclusive", () => {
  assert.deepEqual(parseRange(1000, "bytes=100-199"), {
    kind: "range",
    start: 100,
    end: 199,
  });
});

test("end past EOF is clamped to last byte", () => {
  assert.deepEqual(parseRange(1000, "bytes=900-5000"), {
    kind: "range",
    start: 900,
    end: 999,
  });
});

test("mid-file seek range (the scrub case)", () => {
  assert.deepEqual(parseRange(1000, "bytes=500-"), {
    kind: "range",
    start: 500,
    end: 999,
  });
});

test("suffix range bytes=-N serves the last N bytes", () => {
  assert.deepEqual(parseRange(1000, "bytes=-100"), {
    kind: "range",
    start: 900,
    end: 999,
  });
});

test("suffix larger than file clamps to whole file", () => {
  assert.deepEqual(parseRange(1000, "bytes=-5000"), {
    kind: "range",
    start: 0,
    end: 999,
  });
});

test("start beyond EOF is unsatisfiable (416)", () => {
  assert.deepEqual(parseRange(1000, "bytes=1000-1100"), {
    kind: "unsatisfiable",
  });
  assert.deepEqual(parseRange(1000, "bytes=2000-"), {
    kind: "unsatisfiable",
  });
});

test("start > end is unsatisfiable", () => {
  assert.deepEqual(parseRange(1000, "bytes=500-100"), {
    kind: "unsatisfiable",
  });
});

test("empty file: range unsatisfiable, no-range full", () => {
  assert.deepEqual(parseRange(0, "bytes=0-10"), { kind: "unsatisfiable" });
  assert.deepEqual(parseRange(0, undefined), { kind: "full" });
});

test("whitespace around the header is tolerated", () => {
  assert.deepEqual(parseRange(1000, "  bytes=0-99  "), {
    kind: "range",
    start: 0,
    end: 99,
  });
});

test("content type mapping covers common proxy formats", () => {
  assert.equal(contentTypeForPath("/x/proxy.mp4"), "video/mp4");
  assert.equal(contentTypeForPath("/x/CLIP.MOV"), "video/quicktime");
  assert.equal(contentTypeForPath("/x/a.webm"), "video/webm");
  assert.equal(contentTypeForPath("/x/unknown.xyz"), "application/octet-stream");
});
