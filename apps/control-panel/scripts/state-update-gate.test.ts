import assert from "node:assert/strict";
import { test } from "node:test";
import { StateUpdateGate } from "../src/renderer/state-update-gate.ts";

test("respuesta inicial tardía no reemplaza un evento de polling reciente", () => {
  const gate = new StateUpdateGate();
  const initial = gate.beginRequest();
  gate.acceptEvent();
  assert.equal(gate.isCurrent(initial), false);
});

test("la respuesta más antigua de dos consultas concurrentes no se aplica", () => {
  const gate = new StateUpdateGate();
  const old = gate.beginRequest();
  const newest = gate.beginRequest();
  assert.equal(gate.isCurrent(newest), true);
  assert.equal(gate.isCurrent(old), false);
});
