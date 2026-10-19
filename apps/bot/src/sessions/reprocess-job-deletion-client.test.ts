import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";

import { prepareReprocessJobDeletion } from "./reprocess-job-deletion-client.ts";

const sessionId = "session-1";
const operationId = "4b2aa77f-cc49-4f24-9033-6a48f5f880c1";
const baseUrl = "http://127.0.0.1:8765";
const secret = "fixture-secret";
const request = () => prepareReprocessJobDeletion(sessionId, operationId, baseUrl, secret);
const canonical = JSON.stringify({ operation_type: "reprocess", parameters: {}, session_id: sessionId });
const hash = createHash("sha256").update(canonical).digest("hex");

function pending(overrides: Record<string, unknown> = {}, status = 202): Response {
  return new Response(JSON.stringify({ operation_id: operationId, session_id: sessionId,
    operation_type: "reprocess", parameters_hash: hash, close_id: "a".repeat(32),
    status: "pending_drain", workers_inactive: null, jobs_deleted: false, ...overrides }), { status });
}

describe("reprocess job deletion HTTP client", () => {
  it("sends the persisted UUID and exact parameters, then accepts pending_drain", async (test) => {
    let sent = 0;
    test.mock.method(globalThis, "fetch", async (url: URL | string, init?: RequestInit) => {
      sent++;
      assert.equal(String(url), `${baseUrl}/v1/sessions/${sessionId}/job-deletions`);
      assert.equal(init?.method, "POST");
      assert.equal((init?.headers as Record<string, string>).authorization, `Bearer ${secret}`);
      assert.deepEqual(JSON.parse(String(init?.body)), {
        operation_id: operationId, operation_type: "reprocess", parameters: {},
      });
      return pending();
    });
    await request();
    assert.equal(sent, 1);
  });

  it("rejects an incompatible identity or unsafe state", async (test) => {
    for (const mismatch of [
      { operation_id: "another" }, { session_id: "other" }, { operation_type: "administrative_delete" },
      { parameters_hash: "0".repeat(64) }, { close_id: "invalid" }, { status: "completed" },
      { workers_inactive: true }, { jobs_deleted: true },
    ]) {
      test.mock.method(globalThis, "fetch", async () => pending(mismatch));
      await assert.rejects(request(), /identidad o el estado/);
      test.mock.restoreAll();
    }
  });

  it("recovers a committed POST through GET 200 after a lost response", async (test) => {
    const methods: string[] = [];
    test.mock.method(globalThis, "fetch", async (_url: URL | string, init?: RequestInit) => {
      methods.push(init?.method ?? "");
      if (init?.method === "POST") throw new DOMException("timeout", "TimeoutError");
      return pending({}, 200);
    });
    await request();
    assert.deepEqual(methods, ["POST", "GET"]);
  });

  it("retries only the identical POST after an inconclusive GET 404", async (test) => {
    const bodies: string[] = [];
    const methods: string[] = [];
    test.mock.method(globalThis, "fetch", async (_url: URL | string, init?: RequestInit) => {
      methods.push(init?.method ?? "");
      if (init?.method === "GET") return new Response(null, { status: 404 });
      bodies.push(String(init?.body));
      if (bodies.length === 1) throw new DOMException("timeout", "TimeoutError");
      return pending();
    });
    await request();
    assert.deepEqual(methods, ["POST", "GET", "POST"]);
    assert.deepEqual(bodies, [bodies[0], bodies[0]]);
  });

  it("uses GET after a second lost POST response and stops after two attempts", async (test) => {
    const methods: string[] = [];
    test.mock.method(globalThis, "fetch", async (_url: URL | string, init?: RequestInit) => {
      methods.push(init?.method ?? "");
      if (init?.method === "POST") throw new DOMException("timeout", "TimeoutError");
      return methods.length === 2 ? new Response(null, { status: 404 }) : pending({}, 200);
    });
    await request();
    assert.deepEqual(methods, ["POST", "GET", "POST", "GET"]);
  });

  for (const status of [409, 503]) {
    it(`stops on HTTP ${status} without a fallback DELETE or GET`, async (test) => {
      const methods: string[] = [];
      test.mock.method(globalThis, "fetch", async (_url: URL | string, init?: RequestInit) => {
        methods.push(init?.method ?? "");
        return new Response(null, { status });
      });
      await assert.rejects(request(), new RegExp(`HTTP ${status}`));
      assert.deepEqual(methods, ["POST"]);
    });
  }

  it("stops conservatively when lookup fails or remains absent", async (test) => {
    test.mock.method(globalThis, "fetch", async (_url: URL | string, init?: RequestInit) => {
      if (init?.method === "POST") throw new DOMException("timeout", "TimeoutError");
      throw new Error("lookup unavailable");
    });
    await assert.rejects(request(), /POST y consulta Python inciertos/);
    test.mock.restoreAll();
    test.mock.method(globalThis, "fetch", async (_url: URL | string, init?: RequestInit) => {
      if (init?.method === "POST") throw new DOMException("timeout", "TimeoutError");
      return new Response(null, { status: 404 });
    });
    await assert.rejects(request(), /GET HTTP 404/);
  });

  it("rejects malformed success JSON without treating it as a confirmation", async (test) => {
    test.mock.method(globalThis, "fetch", async () => new Response("{broken", { status: 202 }));
    await assert.rejects(request(), /No se pudo leer la respuesta/);
  });
});
