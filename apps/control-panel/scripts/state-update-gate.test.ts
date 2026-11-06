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

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

test("el éxito nuevo permanece cuando la respuesta vieja llega después", async () => {
  const gate = new StateUpdateGate();
  const first = deferred<string>();
  const second = deferred<string>();
  let shown = "";
  const read = async (promise: Promise<string>) => {
    const request = gate.beginRequest();
    const value = await promise;
    if (gate.isCurrent(request)) shown = value;
  };
  const a = read(first.promise);
  const b = read(second.promise);
  second.resolve("actual");
  await b;
  first.resolve("obsoleto");
  await a;
  assert.equal(shown, "actual");
});

test("el error antiguo no reemplaza un éxito y el error reciente no acepta un éxito antiguo", async () => {
  for (const newestFails of [false, true]) {
    const gate = new StateUpdateGate();
    const first = deferred<string>();
    const second = deferred<string>();
    let shown = "inicial";
    const read = async (promise: Promise<string>) => {
      const request = gate.beginRequest();
      try {
        const value = await promise;
        if (gate.isCurrent(request)) shown = value;
      } catch {
        if (gate.isCurrent(request)) shown = "error";
      }
    };
    const a = read(first.promise);
    const b = read(second.promise);
    if (newestFails) second.reject(new Error("offline"));
    else second.resolve("actual");
    await b;
    if (newestFails) first.resolve("obsoleto");
    else first.reject(new Error("offline"));
    await a;
    assert.equal(shown, newestFails ? "error" : "actual");
  }
});

test("A → B → A invalida la primera carga de A y desmontar invalida consultas", () => {
  const gate = new StateUpdateGate();
  const firstA = gate.beginRequest();
  gate.beginRequest(); // B
  const secondA = gate.beginRequest();
  assert.equal(gate.isCurrent(firstA), false);
  assert.equal(gate.isCurrent(secondA), true);
  gate.invalidate(); // cambio de vista o desmontaje
  assert.equal(gate.isCurrent(secondA), false);
});

test("una acción iniciada en A no actualiza la nueva selección A tras visitar B", async () => {
  const selection = new StateUpdateGate();
  selection.beginRequest(); // A
  const action = selection.snapshot();
  let finish!: () => void;
  const operation = new Promise<void>((resolve) => { finish = resolve; });
  let applied = false;
  const result = operation.then(() => { if (selection.isCurrent(action)) applied = true; });
  selection.beginRequest(); // B
  selection.beginRequest(); // A de nuevo
  finish();
  await result;
  assert.equal(applied, false);
});

test("la respuesta de una instancia anterior queda invalidada al recibir un evento nuevo", () => {
  const gate = new StateUpdateGate();
  const former = gate.beginRequest();
  gate.invalidate(); // La señal de una nueva instancia llegó por IPC.
  const replacement = gate.beginRequest();
  assert.equal(gate.isCurrent(former), false);
  assert.equal(gate.isCurrent(replacement), true);
});
