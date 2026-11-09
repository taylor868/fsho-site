"use strict";

const assert = require("node:assert/strict");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const test = require("node:test");

function load(name) {
  const local = path.join(__dirname, name + ".js");
  return require(fs.existsSync(local) ? local : path.join(__dirname, "../netlify/functions", name + ".js"));
}

const { canonicalJson, leadPayload, payloadSha256 } = load("intake-reserve-contract");

function pythonCanon(value) {
  const script = [
    "import json,sys",
    "obj=json.loads(sys.stdin.read())",
    "sys.stdout.buffer.write(json.dumps(obj, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode('utf-8'))",
  ].join("\n");
  const res = spawnSync("python3", ["-c", script], { input: Buffer.from(JSON.stringify(value), "utf8") });
  if (res.status !== 0) throw new Error(res.stderr.toString());
  return res.stdout.toString("utf8");
}

test("canonical json matches python, including unicode and nested key order", () => {
  const samples = [
    { b: 1, a: { d: 2, c: 3 } },
    { n: "café", e: "你", z: "a\u0001b", u: "line\u2028" },
    { ok: true, no: null, n: 0, neg: -2 },
    { arr: [{ z: 1, a: "x" }, 2] },
    { "é": { b: "quote\"\\", a: "🙂" } },
  ];
  for (const sample of samples) {
    const js = canonicalJson(sample);
    const py = pythonCanon(sample);
    assert.equal(js, py);
    assert.equal(Buffer.from(js, "utf8").equals(Buffer.from(py, "utf8")), true);
  }
});

test("non-integer numbers are rejected and the producer stringifies them", () => {
  assert.throws(() => canonicalJson({ amount: 12.5 }), /decimal_rejected/);
  const py = spawnSync("python3", ["-c", "import json; print(json.dumps(1.5, separators=(',', ':')))"], { encoding: "utf8" });
  assert.equal(py.stdout.trim(), "1.5");
  const lead = leadPayload({ first: "TEST", price: 12.5, ok: true, note: null, city: "São" });
  assert.equal(lead.price, "12.5");
  assert.equal(lead.ok, "true");
  assert.equal(lead.note, undefined);
  assert.equal(canonicalJson(lead), pythonCanon(lead));
  assert.equal(payloadSha256(lead), crypto.createHash("sha256").update(pythonCanon(lead), "utf8").digest("hex"));
});

function nest(n, leaf) {
  let value = leaf;
  for (let i = 0; i < n; i++) value = { a: value };
  return value;
}

test("payload-bind v5 rejects negative zero, unsafe integers, lone surrogates, and depth over 32", () => {
  assert.throws(() => canonicalJson({ n: -0 }), /negative_zero/);
  assert.throws(() => leadPayload({ n: -0 }), /negative_zero/);
  assert.equal(canonicalJson({ n: 0 }), '{"n":0}');
  assert.throws(() => canonicalJson({ n: Number.MAX_SAFE_INTEGER + 2 }), /integer_unsafe/);
  assert.throws(() => canonicalJson({ n: "\uD800" }), /lone_surrogate/);
  assert.throws(() => canonicalJson({ "\uD800": 1 }), /lone_surrogate/);
  assert.throws(() => leadPayload({ first: "\uD800" }), /lone_surrogate/);
  assert.equal(typeof canonicalJson(nest(32, 1)), "string");
  assert.throws(() => canonicalJson(nest(33, 1)), /depth_rejected/);
  assert.throws(() => leadPayload(nest(33, 1)), /depth_rejected/);
  const arrays = JSON.parse("[".repeat(33) + "1" + "]".repeat(33));
  assert.throws(() => canonicalJson(arrays), /depth_rejected/);
});

test("object keys sort by Unicode code point, not UTF-16 code units", () => {
  const emoji = "\u{10000}";
  const bmp = "\uE000";
  const utf16 = [emoji, bmp].sort();
  const point = [emoji, bmp].sort((a, b) => {
    const left = Array.from(a);
    const right = Array.from(b);
    return left[0].codePointAt(0) - right[0].codePointAt(0);
  });
  assert.deepEqual(utf16, [emoji, bmp]);
  assert.deepEqual(point, [bmp, emoji]);
  const body = { [emoji]: 1, [bmp]: 2 };
  assert.equal(canonicalJson(body), pythonCanon(body));
  assert.ok(canonicalJson(body).indexOf(bmp) < canonicalJson(body).indexOf(emoji));
});
