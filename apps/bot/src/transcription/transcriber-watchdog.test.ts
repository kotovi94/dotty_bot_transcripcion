import assert from "node:assert/strict";
import { it } from "node:test";

import { TranscriberWatchdog } from "./transcriber-watchdog.ts";

it("requests one recovery only after repeated health failures", async (test) => {
  let healthy = false;
  test.mock.method(globalThis, "fetch", async () => healthy
    ? new Response(JSON.stringify({ status: "ok" }))
    : new Response("unavailable", { status: 503 }));
  let recoveries = 0;
  const watchdog = new TranscriberWatchdog("http://127.0.0.1:8765/health", () => { recoveries += 1; });
  await watchdog.check();
  await watchdog.check();
  assert.equal(recoveries, 0);
  await watchdog.check();
  assert.equal(recoveries, 1);
  await watchdog.check();
  assert.equal(recoveries, 1);
  healthy = true;
  await watchdog.check();
  assert.equal(recoveries, 1);
});
