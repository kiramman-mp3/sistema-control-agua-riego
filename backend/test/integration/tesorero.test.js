const { resetDatabase, closeDatabase } = require('../helpers/testEnv');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const app = require('../../src/app');
const db = require('../../src/config/db');
const { crearUsuario, crearPersona, crearObligacion, auth } = require('../helpers/fixtures');

let admin, tesorero, usuario;

before(async () => {
  await resetDatabase();
  admin = await crearUsuario({ rol: 'ADMIN' });
  tesorero = await crearUsuario({ rol: 'TESORERO' });
  usuario = await crearUsuario({ rol: 'USUARIO' });
  await crearObligacion({ personaId: usuario.personaId, mes: 1 });
});
after(closeDatabase);

const RUTAS_FINANCIERAS = [
  '/api/financiero/tarifas',
  '/api/financiero/egresos',
  '/api/financiero/balance',
  '/api/financiero/historial',
  '/api/financiero/obligaciones/multas',
  '/api/financiero/agua-anual/resumen?anio=2026'
];

test('solo el tesorero entra a las rutas financieras de la directiva', async () => {
  for (const ruta of RUTAS_FINANCIERAS) {
    assert.equal((await request(app).get(ruta).set(auth(admin))).status, 403, `administrador ${ruta}`);
    assert.equal((await request(app).get(ruta).set(auth(usuario))).status, 403, `usuario ${ruta}`);
    const deTesorero = (await request(app).get(ruta).set(auth(tesorero))).status;
    assert.ok(![401, 403].includes(deTesorero), `tesorero ${ruta}: ${deTesorero}`);
  }
  const cobro = { persona_id: usuario.personaId, obligacionesIds: [1], metodo: 'TRANSFERENCIA', referencia: 'X' };
  assert.equal((await request(app).post('/api/financiero/pagos').set(auth(admin)).send(cobro)).status, 403);
  assert.equal((await request(app).post('/api/financiero/egresos').set(auth(admin)).send({})).status, 403);
  assert.equal((await request(app).post('/api/financiero/tarifas').set(auth(admin)).send({})).status, 403);
});

test('el administrador ve solo sus propias deudas; el tesorero, las de cualquiera', async () => {
  const pedir = (quien) => request(app).get(`/api/financiero/obligaciones?persona_id=${usuario.personaId}`).set(auth(quien));
  const deAdmin = await pedir(admin);
  assert.equal(deAdmin.status, 200);
  assert.equal(deAdmin.body.data.length, 0, 'no ve las deudas de otro usuario');
  const deTesorero = await pedir(tesorero);
  assert.equal(deTesorero.status, 200);
  assert.equal(deTesorero.body.data.length, 1);
});

test('el panel de inicio entrega las finanzas solo al tesorero', async () => {
  const deAdmin = await request(app).get('/api/dashboard/resumen').set(auth(admin));
  assert.equal(deAdmin.status, 200);
  assert.equal(deAdmin.body.data.finanzas, null);
  assert.equal(deAdmin.body.data.cobranza, null);
  assert.ok(deAdmin.body.data.comunidad);

  const deTesorero = await request(app).get('/api/dashboard/resumen').set(auth(tesorero));
  assert.equal(deTesorero.status, 200);
  assert.equal(typeof deTesorero.body.data.finanzas.saldoCaja, 'number');
  assert.ok(deTesorero.body.data.cobranza);
});

test('el administrador no puede conceder el rol de tesorero ni tocar su cuenta mientras haya un tesorero activo', async () => {
  const aspirante = await crearPersona();
  const crear = await request(app).post(`/api/personas/${aspirante.personaId}/cuenta`).set(auth(admin)).send({ rol: 'TESORERO' });
  assert.equal(crear.status, 403);
  const [[{ cuentas }]] = await db.query('SELECT COUNT(*) AS cuentas FROM cuentas WHERE persona_id = ?', [aspirante.personaId]);
  assert.equal(cuentas, 0);

  const alta = await request(app).post('/api/personas').set(auth(admin))
    .send({ cedula: '1712345675', nombres: 'Otro', apellidos: 'Tesorero', crearCuenta: true, rol: 'TESORERO' });
  assert.equal(alta.status, 403);

  const cuenta = `/api/personas/${tesorero.personaId}/cuenta`;
  assert.equal((await request(app).patch(cuenta).set(auth(admin))
    .send({ estado: 'BLOQUEADA' })).status, 403);
  assert.equal((await request(app).patch(cuenta).set(auth(admin)).send({ rol: 'ADMIN' })).status, 403);
  assert.equal((await request(app).post(`${cuenta}/restablecer-password`).set(auth(admin))).status, 403);
  assert.equal((await request(app).put(`/api/personas/${tesorero.personaId}`).set(auth(admin))
    .send({ nombres: 'Cambio', apellidos: 'Indebido', estado: 'INACTIVO' })).status, 403);

  const [[{ rol }]] = await db.query('SELECT r.codigo AS rol FROM cuentas c JOIN roles r ON r.id = c.rol_id WHERE c.id = ?', [tesorero.cuentaId]);
  assert.equal(rol, 'TESORERO');
  const [[{ estado }]] = await db.query('SELECT estado FROM cuentas WHERE id = ?', [tesorero.cuentaId]);
  assert.equal(estado, 'ACTIVA');
});

test('el tesorero sí gestiona cuentas, incluida la del administrador y la designación de otro tesorero', async () => {
  const nuevo = await crearPersona();
  const creada = await request(app).post(`/api/personas/${nuevo.personaId}/cuenta`).set(auth(tesorero)).send({ rol: 'ADMIN' });
  assert.equal(creada.status, 201, JSON.stringify(creada.body));
  const ascenso = await request(app).patch(`/api/personas/${nuevo.personaId}/cuenta`).set(auth(tesorero)).send({ rol: 'TESORERO' });
  assert.equal(ascenso.status, 200, JSON.stringify(ascenso.body));
  const reinicio = await request(app).post(`/api/personas/${admin.personaId}/cuenta/restablecer-password`).set(auth(tesorero));
  assert.equal(reinicio.status, 200);
});

test('sin ningún tesorero activo, un administrador puede designar al primero', async () => {
  await db.query("UPDATE cuentas SET estado = 'INACTIVA' WHERE rol_id = (SELECT id FROM roles WHERE codigo = 'TESORERO')");
  const otroAdmin = await crearUsuario({ rol: 'ADMIN' });
  const aspirante = await crearPersona();
  const crear = await request(app).post(`/api/personas/${aspirante.personaId}/cuenta`).set(auth(otroAdmin)).send({ rol: 'TESORERO' });
  assert.equal(crear.status, 201, JSON.stringify(crear.body));
});
