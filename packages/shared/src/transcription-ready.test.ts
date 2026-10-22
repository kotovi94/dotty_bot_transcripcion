import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { it } from "node:test";
import {
  createReadyMarker, jobsDigest, parseReadyMarker, serializeReadyMarker,
  transcriptDigest, verifyReadyMarker, type PublicationJob,
} from "./transcription-ready.ts";

const publishedAt = "2026-10-20T12:00:00.000Z";
const bytes = (value: string) => Buffer.from(value, "utf8");
const job = (id: string, result: unknown = { segments: [{ text: "hola", start_ms: 0 }] }): PublicationJob => ({
  id, status: "completed", speaker_user_id: "user-1", start_offset_ms: 0,
  completed_at: "2026-10-20T11:59:59.123456+00:00", result,
});
const jobs = () => [job("session:clip-a"), job("session:clip-b", { segments: [] })];
const marker = () => serializeReadyMarker(createReadyMarker("session", jobs(), bytes("# Bitácora\n"), publishedAt));

it("same jobs and results produce the same digest despite JSON key insertion order", () => {
  const first = job("session:clip-a", { language: "es", segments: [{ text: "hola", start_ms: 0 }] });
  const second = job("session:clip-a", { segments: [{ start_ms: 0, text: "hola" }], language: "es" });
  assert.equal(jobsDigest("session", [first]), jobsDigest("session", [second]));
});

it("input job order does not change the digest", () => {
  assert.equal(jobsDigest("session", jobs()), jobsDigest("session", jobs().reverse()));
});

it("a changed result or a new completion changes the digest", () => {
  const baseline = jobs();
  assert.notEqual(jobsDigest("session", baseline), jobsDigest("session", [
    job("session:clip-a", { segments: [{ text: "adiós", start_ms: 0 }] }), baseline[1]!,
  ]));
  assert.notEqual(jobsDigest("session", baseline), jobsDigest("session", [
    { ...baseline[0]!, completed_at: "2026-10-20T12:01:00+00:00" }, baseline[1]!,
  ]));
  assert.notEqual(jobsDigest("session", baseline), jobsDigest("session", [
    { ...baseline[0]!, speaker_user_id: "user-2" }, baseline[1]!,
  ]));
  assert.notEqual(jobsDigest("session", baseline), jobsDigest("session", [
    { ...baseline[0]!, start_offset_ms: 1000 }, baseline[1]!,
  ]));
});

it("a different session or foreign job cannot verify", () => {
  assert.equal(verifyReadyMarker(marker(), "other", jobs(), bytes("# Bitácora\n")), "mismatch");
  assert.throws(() => jobsDigest("session", [job("other:clip-a")]), /Job ID/u);
});

it("a changed transcript byte invalidates verification", () => {
  assert.equal(verifyReadyMarker(marker(), "session", jobs(), bytes("# Bitácora\n")), "verified");
  assert.equal(verifyReadyMarker(marker(), "session", jobs(), bytes("# Bitácora\r\n")), "mismatch");
  assert.equal(transcriptDigest(bytes("é")), createHash("sha256").update(bytes("é")).digest("hex"));
});

it("historical timestamp markers are recognized as unverifiable", () => {
  assert.deepEqual(parseReadyMarker(`${publishedAt}\n`), { kind: "legacy-unverifiable" });
  assert.equal(verifyReadyMarker(`${publishedAt}\n`, "session", jobs(), bytes("# Bitácora\n")), "legacy-unverifiable");
});

it("corrupt markers are rejected", () => {
  for (const content of ["", "garbage", "{}", "{\"version\":1}", `${publishedAt}\nmore`,
    JSON.stringify({ ...JSON.parse(marker()), jobs_digest: "not-a-digest" })]) {
    assert.equal(parseReadyMarker(content).kind, "invalid");
  }
});

it("unknown versions and extra fields are rejected", () => {
  const current = JSON.parse(marker()) as Record<string, unknown>;
  assert.equal(parseReadyMarker(JSON.stringify({ ...current, version: 2 })).kind, "invalid");
  assert.equal(parseReadyMarker(JSON.stringify({ ...current, extra: true })).kind, "invalid");
});

it("incomplete jobs cannot produce or verify a publication", () => {
  for (const status of ["queued", "processing", "failed"]) {
    const incomplete = [{ ...job("session:clip-a"), status, result: status === "failed" ? null : {} }];
    assert.throws(() => createReadyMarker("session", incomplete, bytes("texto"), publishedAt), /completed result/u);
    assert.equal(verifyReadyMarker(marker(), "session", incomplete, bytes("# Bitácora\n")), "mismatch");
  }
});

it("empty, duplicate and contradictory inputs fail closed", () => {
  assert.throws(() => jobsDigest("session", []), /At least one/u);
  assert.throws(() => jobsDigest("session", [job("session:clip-a"), job("session:clip-a")]), /duplicated/u);
  assert.throws(() => jobsDigest("session", [{ ...job("session:clip-a"), completed_at: null }]), /completed result/u);
  assert.throws(() => jobsDigest("session", [job("session:clip-a", {})]), /completed result/u);
  assert.throws(() => jobsDigest("session", [job("session:clip-a", { segments: [undefined] })]), /non-JSON/u);
  assert.throws(() => transcriptDigest(bytes("")), /nonempty/u);
  assert.throws(() => createReadyMarker("session", jobs(), bytes("texto"), "yesterday"), /published_at/u);
});

it("serialized v1 marker has exactly the documented fields and trailing LF", () => {
  const value = marker();
  assert.match(value, /^\{"version":1,"session_id":"session","jobs_digest":"[0-9a-f]{64}","transcript_digest":"[0-9a-f]{64}","published_at":"2026-10-20T12:00:00.000Z"\}\n$/u);
  assert.equal(parseReadyMarker(value).kind, "verifiable");
});
