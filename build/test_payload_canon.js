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
