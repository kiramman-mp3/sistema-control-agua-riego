const { test } = require('node:test');
const assert = require('node:assert/strict');
const { recargoAgua, limiteSinRecargo, RECARGO_AGUA } = require('../../src/services/finanzasService');

test('hasta el 31 de marzo del año de la cuota no hay recargo', () => {
  assert.equal(limiteSinRecargo(2026), '2026-03-31');
  assert.equal(recargoAgua(2026, 100, '2026-01-01'), 0);
  assert.equal(recargoAgua(2026, 100, '2026-03-31'), 0, 'el 31 de marzo todavía se paga el valor base');
  assert.equal(recargoAgua(2026, 100, '2025-12-15'), 0, 'pagar por adelantado no lleva recargo');
});

test('desde el 1 de abril se suma el 10% una sola vez, sin importar cuánto se atrase', () => {
  assert.equal(RECARGO_AGUA, 0.1);
  assert.equal(recargoAgua(2026, 100, '2026-04-01'), 10);
  assert.equal(recargoAgua(2026, 100, '2026-12-31'), 10);
  assert.equal(recargoAgua(2026, 100, '2027-06-01'), 10, 'no crece por meses');
});

test('una cuota de un año anterior siempre lleva el recargo', () => {
  assert.equal(recargoAgua(2024, 80, '2026-02-01'), 8);
});

test('el recargo se redondea al centavo', () => {
  assert.equal(recargoAgua(2026, 12.04, '2026-05-01'), 1.2);
  assert.equal(recargoAgua(2026, 33.33, '2026-05-01'), 3.33);
  assert.equal(recargoAgua(2026, 0.05, '2026-05-01'), 0.01);
});
