import { test } from "node:test";
import assert from "node:assert/strict";
import { createRadarLoader } from "../../src/lib/radar-load.mjs";

const enoent = () => Object.assign(new Error("no such file"), { code: "ENOENT" });
const registryError = (message) => Object.assign(new Error(message), { name: "RadarRegistryError" });

function harness({ stat, read }) {
  const calls = { read: 0 };
  const loader = createRadarLoader({
    stat,
    readRegistry: async (path) => { calls.read++; return read(path); },
  });
  return { loader, calls };
}

test("a missing file is an empty registry", async () => {
  const { loader } = harness({ stat: () => { throw enoent(); }, read: () => { throw new Error("must not read"); } });
  assert.deepEqual(await loader("/r/data/radar.tsv"), { state: "empty" });
});

test("a readable registry is returned and parsed once while the file is unchanged", async () => {
  const rows = [{ key: "acme" }];
  const { loader, calls } = harness({ stat: () => ({ mtimeMs: 1, size: 10 }), read: () => ({ rows, missing: false }) });
  const first = await loader("/r/data/radar.tsv");
  const second = await loader("/r/data/radar.tsv");
  assert.deepEqual(first, { state: "ok", rows });
  assert.equal(second.rows, rows);
  assert.equal(calls.read, 1);
});

test("a changed modification time or size reloads the file", async () => {
  let stamp = { mtimeMs: 1, size: 10 };
  const { loader, calls } = harness({ stat: () => stamp, read: () => ({ rows: [], missing: false }) });
  await loader("/p");
  stamp = { mtimeMs: 2, size: 10 };
  await loader("/p");
  stamp = { mtimeMs: 2, size: 11 };
  await loader("/p");
  assert.equal(calls.read, 3);
});

test("a malformed registry is an error state with its message and is never cached", async () => {
  let broken = true;
  const { loader, calls } = harness({
    stat: () => ({ mtimeMs: 1, size: 10 }),
    read: () => { if (broken) throw registryError("line 3: duplicate key"); return { rows: [{ key: "a" }], missing: false }; },
  });
  assert.deepEqual(await loader("/p"), { state: "error", message: "line 3: duplicate key" });
  assert.deepEqual(await loader("/p"), { state: "error", message: "line 3: duplicate key" });
  assert.equal(calls.read, 2, "the failure was not cached");
  broken = false;
  assert.equal((await loader("/p")).state, "ok");
});

test("an unexpected failure is rethrown, not shown as an empty or error state", async () => {
  const { loader } = harness({ stat: () => ({ mtimeMs: 1, size: 1 }), read: () => { throw new TypeError("bug"); } });
  await assert.rejects(loader("/p"), TypeError);
  const { loader: statFails } = harness({ stat: () => { throw Object.assign(new Error("denied"), { code: "EACCES" }); }, read: () => ({ rows: [] }) });
  await assert.rejects(statFails("/p"), /denied/);
});
