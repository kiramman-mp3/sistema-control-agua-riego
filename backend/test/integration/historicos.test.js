const { resetDatabase, closeDatabase } = require('../helpers/testEnv');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const app = require('../../src/app');
const db = require('../../src/config/db');
const { hoy } = require('../../src/shared/dates');
const { crearUsuario, auth, crearSector, crearLote, conceptoId, crearObligacion } = require('../helpers/fixtures');

const ANIO = Number(hoy().slice(0, 4));
const MES = Number(hoy().slice(5, 7));
let tesorero, directivo, socio, otro, sector, lote1, lote2;
const COMPROBANTE = Buffer.from('%PDF-1.4\nComprobante\n%%EOF');

const historico = (personaId, quien = tesorero) => request(app).get(`/api/financiero/historico/${personaId}`).set(auth(quien));
const guardar = (personaId, cuerpo, quien = tesorero) => request(app).put(`/api/financiero/historico/${personaId}`).set(auth(quien)).send(cuerpo);
const deudores = (quien = tesorero) => request(app).get('/api/financiero/deudores').set(auth(quien));
const balance = () => request(app).get('/api/financiero/balance').set(auth(tesorero));
/** Recargo del 10% de una cuota del agua que se paga hoy. */
const conRecargo = (anio, valor) => (hoy() > `${anio}-03-31` ? Math.round(valor * 110) / 100 : valor);

before(async () => {
  await resetDatabase();
  tesorero = await crearUsuario({ rol: 'TESORERO' });
  directivo = await crearUsuario({ rol: 'ADMIN' });
  socio = await crearUsuario({ nombres: 'Rosa', apellidos: 'Caiza' });
  otro = await crearUsuario({ nombres: 'Luis', apellidos: 'Tapia' });
  sector = await crearSector('La Jones Alta');
  lote1 = await crearLote({ sectorId: sector, personaId: socio.personaId, codigo: 'LJA-901', superficie: 20000 }); // 2 ha
  lote2 = await crearLote({ sectorId: sector, personaId: socio.personaId, codigo: 'LJA-902', superficie: 5000 }); // 0,5 ha
});
after(closeDatabase);

test('solo la tesorería registra y consulta históricos, deudores y caja previa', async () => {
  for (const quien of [directivo, socio]) {
    assert.equal((await historico(socio.personaId, quien)).status, 403);
    assert.equal((await guardar(socio.personaId, { lotes: [] }, quien)).status, 403);
    assert.equal((await deudores(quien)).status, 403);
    assert.equal((await request(app).get('/api/financiero/ingresos-previos').set(auth(quien))).status, 403);
  }
  assert.equal((await request(app).get('/api/financiero/deudores')).status, 401);
});

test('los conceptos de años anteriores no aparecen en Tarifas', async () => {
  const conceptos = (await request(app).get('/api/financiero/conceptos').set(auth(tesorero))).body.data.map((c) => c.codigo);
  assert.ok(conceptos.includes('MULTA_ASAMBLEA'));
  for (const codigo of ['AGUA_ANTERIOR', 'MULTA_ASAMBLEA_ANTERIOR', 'MULTA_MINGA_ANTERIOR']) {
    assert.ok(!conceptos.includes(codigo), `${codigo} no se tarifica`);
  }
});

test('el histórico parte vacío y lista los lotes del usuario con su superficie', async () => {
  const res = await historico(socio.personaId);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const d = res.body.data;
  assert.equal(d.anio, ANIO);
  assert.equal(d.mes_actual, MES);
  assert.deepEqual(d.lotes.map((l) => [l.codigo, l.hectareas, l.cuota]), [['LJA-901', 2, null], ['LJA-902', 0.5, null]]);
  assert.equal(d.agua_anterior, null);
  assert.equal(d.valor_hectarea_sugerido, null, 'sin tarifa registrada');
  assert.equal((await historico(999999)).status, 404);
});

test('sin valor por hectárea ni tarifa no se calcula el agua del año', async () => {
  const res = await guardar(socio.personaId, { lotes: [{ lote_id: lote1, estado: 'DEBE' }] });
  assert.equal(res.status, 409);
  assert.match(res.body.message, /tarifa/i);
});

test('un lote que debe queda pendiente con su cuota por hectárea y otro pagado en papel queda pagado sin recibo', async () => {
  const res = await guardar(socio.personaId, {
    valor_hectarea: 60,
    lotes: [{ lote_id: lote1, estado: 'DEBE' }, { lote_id: lote2, estado: 'PAGADA' }]
  });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const [cuotas] = await db.query('SELECT lote_id, valor_total, estado, pagada_antes_sistema, fecha_vencimiento FROM obligacion_anual_agua WHERE persona_id = ? ORDER BY lote_id', [socio.personaId]);
  assert.deepEqual(cuotas.map((c) => [Number(c.lote_id), Number(c.valor_total), c.estado, Boolean(c.pagada_antes_sistema), c.fecha_vencimiento]), [
    [lote1, 120, 'PENDIENTE', false, `${ANIO}-03-31`],
    [lote2, 30, 'PAGADA', true, `${ANIO}-03-31`]
  ]);
  const [[{ pagos }]] = await db.query('SELECT COUNT(*) AS pagos FROM pago_anual_agua');
  assert.equal(pagos, 0, 'pagar en papel no crea un recibo');
  assert.equal((await balance()).body.balance.totalIngresos, 0, 'tampoco suma a los ingresos de caja');

  // Guardar de nuevo no duplica ni cambia lo ya existente
  assert.equal((await guardar(socio.personaId, { valor_hectarea: 99, lotes: [{ lote_id: lote1, estado: 'DEBE' }, { lote_id: lote2, estado: 'PAGADA' }] })).status, 200);
  const [[{ n, total }]] = await db.query('SELECT COUNT(*) AS n, SUM(valor_total) AS total FROM obligacion_anual_agua WHERE persona_id = ?', [socio.personaId]);
  assert.equal(n, 2);
  assert.equal(Number(total), 150);

  const d = (await historico(socio.personaId)).body.data;
  assert.deepEqual(d.lotes.map((l) => [l.cuota.estado, l.cuota.pagada_antes_sistema]), [['PENDIENTE', false], ['PAGADA', true]]);
});

test('la cuota pendiente cobra el recargo en caja y la pagada en papel no se vuelve a cobrar', async () => {
  const pendientes = (await request(app).get(`/api/financiero/agua-anual/obligaciones/${socio.personaId}`).set(auth(tesorero))).body.data;
  assert.equal(pendientes.length, 1, 'la cuota pagada en papel no está pendiente');
  assert.equal(pendientes[0].valor_total, 120);
  assert.equal(pendientes[0].total_a_cobrar, conRecargo(ANIO, 120));

  const consulta = await request(app).get(`/api/personas/consulta/${socio.cedula}`).set(auth(socio));
  const agua = consulta.body.resultado.deudas.filter((d) => d.tipo === 'AGUA_ANUAL');
  const pagada = agua.find((d) => d.estado === 'PAGADA');
  assert.equal(pagada.pagadaAntesSistema, true);
  assert.equal(pagada.pagoAnualId, null, 'sin recibo');
});

test('el acumulado de años anteriores y las multas por mes se guardan y se corrigen', async () => {
  const res = await guardar(socio.personaId, {
    agua_anterior: 80,
    multas_asamblea: { anterior: 30, meses: { 1: 10, [String(MES)]: 5 } },
    multas_minga: { anterior: 0, meses: { 1: 15 } }
  });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const [filas] = await db.query(
    `SELECT c.codigo, o.periodo_anio, o.periodo_mes, o.valor, o.estado, o.origen, o.observacion FROM obligaciones o
     JOIN conceptos_cobro c ON c.id = o.concepto_id WHERE o.persona_id = ? ORDER BY c.codigo, o.periodo_mes`, [socio.personaId]
  );
  const resumen = filas.map((f) => [f.codigo, f.periodo_anio, f.periodo_mes, Number(f.valor), f.estado]);
  const esperadas = [
    ['AGUA_ANTERIOR', null, null, 80, 'PENDIENTE'],
    ['MULTA_ASAMBLEA', ANIO, 1, 10, 'PENDIENTE'],
    ['MULTA_ASAMBLEA_ANTERIOR', null, null, 30, 'PENDIENTE'],
    ['MULTA_MINGA', ANIO, 1, 15, 'PENDIENTE']
  ];
  if (MES !== 1) esperadas.splice(2, 0, ['MULTA_ASAMBLEA', ANIO, MES, 5, 'PENDIENTE']);
  assert.deepEqual(resumen, esperadas);
  assert.ok(filas.every((f) => f.origen === 'MANUAL' && /Histórico/.test(f.observacion)));

  // Corregir: cambiar un valor, quitar otro con 0 y no tocar lo que no se envía
  assert.equal((await guardar(socio.personaId, { agua_anterior: 95, multas_minga: { meses: { 1: 0 } } })).status, 200);
  const estado = (await historico(socio.personaId)).body.data;
  assert.equal(estado.agua_anterior.valor, 95);
  assert.deepEqual(estado.multas.MINGA.meses, {}, 'el cero anuló la multa pendiente');
  assert.equal(estado.multas.ASAMBLEA.anterior.valor, 30, 'lo no enviado queda igual');
  const [[{ n }]] = await db.query("SELECT COUNT(*) AS n FROM obligaciones o JOIN conceptos_cobro c ON c.id = o.concepto_id WHERE o.persona_id = ? AND c.codigo = 'AGUA_ANTERIOR'", [socio.personaId]);
  assert.equal(n, 1, 'corregir no duplica el acumulado');
});

test('valida los importes, los meses y los años', async () => {
  for (const cuerpo of [
    { agua_anterior: -5 }, { agua_anterior: 'x' }, { agua_anterior: 10.123 },
    { multas_asamblea: { meses: { 13: 5 } } }, { multas_asamblea: { meses: { 0: 5 } } }, { multas_minga: { anterior: -1 } },
    { anio: ANIO + 1 }, { lotes: [{ lote_id: lote1, estado: 'OTRO' }] }
  ]) {
    assert.equal((await guardar(socio.personaId, cuerpo)).status, 400, JSON.stringify(cuerpo));
  }
  if (MES < 12) {
    const futuro = await guardar(socio.personaId, { multas_minga: { meses: { [String(MES + 1)]: 5 } } });
    assert.equal(futuro.status, 400, 'no se anotan multas de meses que aún no llegan');
  }
  const ajeno = await guardar(otro.personaId, { valor_hectarea: 60, lotes: [{ lote_id: lote1, estado: 'DEBE' }] });
  assert.equal(ajeno.status, 400, 'un lote de otro usuario');
});

test('lo ya cobrado en caja no se modifica desde el histórico', async () => {
  const [{ insertId }] = await db.query(
    "INSERT INTO obligaciones (persona_id, concepto_id, periodo_anio, periodo_mes, fecha_emision, valor, origen, estado) VALUES (?, ?, NULL, NULL, CURDATE(), 12, 'MANUAL', 'PENDIENTE')",
    [otro.personaId, await conceptoId('AGUA_ANTERIOR')]
  );
  const pago = await request(app).post('/api/financiero/pagos').set(auth(tesorero))
    .send({ persona_id: otro.personaId, obligacionesIds: [insertId], metodo: 'TRANSFERENCIA', referencia: 'TRF-ANT-1' });
  assert.equal(pago.status, 201, JSON.stringify(pago.body));
  const intento = await guardar(otro.personaId, { agua_anterior: 20 });
  assert.equal(intento.status, 409);
  assert.match(intento.body.message, /ya fue cobrado/);
  assert.equal((await guardar(otro.personaId, { agua_anterior: 12 })).status, 200, 'el mismo valor no es un cambio');

  // La cuota del año cobrada con recibo tampoco puede volver a pendiente
  const sector2 = await crearSector('Sector cobrado');
  const lote = await crearLote({ sectorId: sector2, personaId: otro.personaId, codigo: 'COB-001' });
  const [cuota] = await db.query(
    `INSERT INTO obligacion_anual_agua (persona_id, lote_id, periodo_anio, valor_total, valor_hectarea, superficie_m2, estado, fecha_emision, fecha_vencimiento)
     VALUES (?, ?, ?, 60, 60, 10000, 'PENDIENTE', ?, ?)`, [otro.personaId, lote, ANIO, `${ANIO}-01-01`, `${ANIO}-03-31`]
  );
  const cobro = await request(app).post('/api/financiero/agua-anual/pagos').set(auth(tesorero))
    .field('persona_id', String(otro.personaId)).field('obligacionesIds', JSON.stringify([cuota.insertId]))
    .field('metodo', 'TRANSFERENCIA').field('referencia', 'TRF-HIST-2').attach('archivo', COMPROBANTE, 'banco.pdf');
  assert.equal(cobro.status, 201, JSON.stringify(cobro.body));
  assert.equal(cobro.body.valorTotal, conRecargo(ANIO, 60));
  const revertir = await guardar(otro.personaId, { lotes: [{ lote_id: lote, estado: 'DEBE' }] });
  assert.equal(revertir.status, 409);
  assert.match(revertir.body.message, /recibo/);
  // Marcarla como pagada en papel no cambia nada: ya está pagada
  assert.equal((await guardar(otro.personaId, { lotes: [{ lote_id: lote, estado: 'PAGADA' }] })).status, 200);
});

test('quien tiene lotes sin superficie bloquea el cálculo del agua y se informa cuáles son', async () => {
  const sinSup = await crearUsuario();
  const lote = await crearLote({ sectorId: sector, personaId: sinSup.personaId, codigo: 'LJA-903' });
  await db.query('UPDATE lotes SET superficie_m2 = NULL WHERE id = ?', [lote]);
  const res = await guardar(sinSup.personaId, { valor_hectarea: 60, lotes: [{ lote_id: lote, estado: 'DEBE' }] });
  assert.equal(res.status, 409);
  assert.deepEqual(res.body.lotes_sin_superficie.map((l) => l.codigo), ['LJA-903']);
});

test('los deudores muestran el año en curso desglosado, los años anteriores juntos y el recargo del agua', async () => {
  // Una multa de un año que ya terminó cuenta como "años anteriores" aunque no sea un acumulado digitado
  await crearObligacion({ personaId: socio.personaId, codigo: 'MULTA_MINGA', anio: ANIO - 1, mes: 6, valor: 7 });
  await db.query(
    `INSERT INTO obligacion_anual_agua (persona_id, lote_id, periodo_anio, valor_total, estado, fecha_emision, fecha_vencimiento)
     VALUES (?, ?, ?, 50, 'PENDIENTE', ?, ?)`, [socio.personaId, lote2, ANIO - 1, `${ANIO - 1}-01-01`, `${ANIO - 1}-03-31`]
  );

  const res = await deudores();
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const { resumen, deudores: lista, anio } = res.body.data;
  assert.equal(anio, ANIO);
  const rosa = lista.find((d) => d.persona_id === socio.personaId);
  assert.ok(rosa);

  // Agua: cuota del año 120 (+10%), y años anteriores: 95 digitados + 50 de la cuota del año pasado (+10%)
  assert.equal(rosa.agua.actual, 120);
  assert.equal(rosa.agua.recargo_actual, conRecargo(ANIO, 120) - 120);
  assert.equal(rosa.agua.anteriores, 95 + conRecargo(ANIO - 1, 50));
  assert.deepEqual(rosa.agua.lotes_actual, ['LJA-901']);
  assert.equal(rosa.agua.total, 120 + (conRecargo(ANIO, 120) - 120) + 95 + conRecargo(ANIO - 1, 50));

  // Multas de asambleas: 10 de enero y 5 del mes actual (o solo 10 si estamos en enero), y 30 de años anteriores
  assert.equal(rosa.multas_asamblea.anteriores, 30);
  assert.deepEqual(rosa.multas_asamblea.meses.map((m) => [m.mes, m.valor]), MES === 1 ? [[1, 10]] : [[1, 10], [MES, 5]]);
  assert.equal(rosa.multas_asamblea.actual, MES === 1 ? 10 : 15);
  // Mingas: la de enero se quitó con 0; la del año pasado va a "años anteriores"
  assert.equal(rosa.multas_minga.actual, 0);
  assert.equal(rosa.multas_minga.anteriores, 7);
  assert.equal(rosa.total_multas, rosa.multas_asamblea.actual + 30 + 7);

  // Quien no debe nada no aparece; el resumen suma a los deudores
  assert.ok(!lista.some((d) => d.persona_id === tesorero.personaId));
  assert.equal(resumen.usuarios, lista.length);
  assert.equal(Math.round(resumen.total * 100), Math.round(lista.reduce((s, d) => s + d.total, 0) * 100));
  assert.equal(resumen.agua.usuarios, lista.filter((d) => d.agua.total > 0).length);
  const ordenados = [...lista].sort((a, b) => b.total - a.total);
  assert.deepEqual(lista.map((d) => d.persona_id), ordenados.map((d) => d.persona_id), 'del que más debe al que menos');
});

test('el deudor sale del reporte cuando paga todo, y el pago de años anteriores se cobra en caja', async () => {
  const pendientes = (await request(app).get(`/api/financiero/obligaciones?persona_id=${socio.personaId}&estado=PENDIENTE`).set(auth(tesorero))).body.data;
  const ids = pendientes.map((o) => o.id);
  const pago = await request(app).post('/api/financiero/pagos').set(auth(tesorero))
    .send({ persona_id: socio.personaId, obligacionesIds: ids, metodo: 'DEPOSITO', referencia: 'DEP-HIST-1' });
  assert.equal(pago.status, 201, JSON.stringify(pago.body));
  const rosa = (await deudores()).body.data.deudores.find((d) => d.persona_id === socio.personaId);
  assert.equal(rosa.total_multas, 0);
  assert.ok(rosa.agua.total > 0, 'el agua se cobra aparte, con comprobante bancario');
});

test('la caja previa al sistema suma al balance como un total, sin pagos ni recibos', async () => {
  const ingresosAntes = (await balance()).body.balance;
  const [[{ pagos: pagosAntes }]] = await db.query('SELECT (SELECT COUNT(*) FROM pagos) + (SELECT COUNT(*) FROM pago_anual_agua) AS pagos');
  const registrar = (cuerpo, quien = tesorero) => request(app).post('/api/financiero/ingresos-previos').set(auth(quien)).send(cuerpo);
  assert.equal((await registrar({ fecha: '2026-01-10', valor: 500, descripcion: 'Caja' })).status, 400, 'la descripción es muy corta');
  assert.equal((await registrar({ fecha: '2999-01-10', valor: 500, descripcion: 'Caja anterior al sistema' })).status, 400);
  assert.equal((await registrar({ fecha: '2026-01-10', valor: 0, descripcion: 'Caja anterior al sistema' })).status, 400);
  assert.equal((await registrar({ fecha: '2026-01-10', valor: 500, descripcion: 'Caja anterior al sistema' }, directivo)).status, 403);

  const creado = await registrar({ fecha: '2026-01-10', valor: 1250.5, descripcion: 'Total en caja al iniciar el sistema' });
  assert.equal(creado.status, 201, JSON.stringify(creado.body));
  const despues = (await balance()).body.balance;
  assert.equal(despues.totalIngresos, Math.round((ingresosAntes.totalIngresos + 1250.5) * 100) / 100);
  assert.equal(despues.balanceAlDia, Math.round((ingresosAntes.balanceAlDia + 1250.5) * 100) / 100);

  const [[{ pagos }]] = await db.query('SELECT (SELECT COUNT(*) FROM pagos) + (SELECT COUNT(*) FROM pago_anual_agua) AS pagos');
  assert.equal(pagos, pagosAntes, 'no crea pagos ni recibos');

  const historial = (await request(app).get('/api/financiero/historial').set(auth(tesorero))).body.data;
  assert.equal(historial.total.ingresos, despues.totalIngresos);
  const enero = historial.anios.find((a) => a.anio === 2026).meses.find((m) => m.mes === '2026-01');
  assert.ok(enero.ingresos >= 1250.5);
  const panel = (await request(app).get('/api/dashboard/resumen').set(auth(tesorero))).body.data.finanzas;
  assert.equal(panel.saldoCaja, despues.balanceAlDia);

  const rango = (await request(app).get('/api/financiero/balance?desde=2026-02-01&hasta=2026-02-28').set(auth(tesorero))).body.balance;
  assert.equal(rango.totalIngresos, 0, 'respeta el rango de fechas');

  const lista = (await request(app).get('/api/financiero/ingresos-previos').set(auth(tesorero))).body.data;
  assert.deepEqual(lista.map((i) => [i.valor, i.estado]), [[1250.5, 'VIGENTE']]);

  // Anular: motivo obligatorio y sale del balance
  const id = creado.body.id;
  const anular = (motivo) => request(app).post(`/api/financiero/ingresos-previos/${id}/anular`).set(auth(tesorero)).send({ motivo });
  assert.equal((await anular('x')).status, 400);
  assert.equal((await anular('Registrado dos veces')).status, 200);
  assert.equal((await anular('Otra vez')).status, 409);
  assert.equal((await balance()).body.balance.totalIngresos, ingresosAntes.totalIngresos);
  const [[auditoria]] = await db.query("SELECT COUNT(*) AS n FROM auditoria WHERE entidad = 'ingresos_previos'");
  assert.equal(auditoria.n, 2, 'el alta y la anulación quedan auditadas');
});

test('guardar el histórico queda en la auditoría', async () => {
  const [[{ n }]] = await db.query("SELECT COUNT(*) AS n FROM auditoria WHERE entidad = 'historico_deudas' AND accion = 'CREAR'");
  assert.ok(n >= 3);
});
