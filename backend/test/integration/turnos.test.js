const { resetDatabase, closeDatabase } = require('../helpers/testEnv');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const app = require('../../src/app');
const db = require('../../src/config/db');
const { crearUsuario, auth, crearSector, crearLote } = require('../helpers/fixtures');

let admin, usuario, vecino, sector, sectorBajo;

before(async () => {
  await resetDatabase();
  admin = await crearUsuario({ rol: 'ADMIN' });
  usuario = await crearUsuario();
  vecino = await crearUsuario();
  sector = await crearSector('La Jones Alta');
  sectorBajo = await crearSector('La Jones Baja');
  await crearLote({ sectorId: sector, personaId: usuario.personaId, codigo: 'LJA-101' });
  await crearLote({ sectorId: sectorBajo, personaId: vecino.personaId, codigo: 'LJB-201' });
});
after(closeDatabase);

const crear = (body) => request(app).post('/api/turnos').set(auth(admin)).send(body);
const editar = (id, body) => request(app).put(`/api/turnos/${id}`).set(auth(admin)).send(body);
const base = () => ({ sector_id: sector, dia_semana: 2 });
const delBajo = (dia, hora_inicio, hora_fin) => ({ sector_id: sectorBajo, dia_semana: dia, hora_inicio, hora_fin });

test('las horas sin cero inicial se comparan como horas, no como texto', async () => {
  // Como texto, '9:00' > '10:00'; antes este turno válido se rechazaba.
  const r = await crear({ ...base(), hora_inicio: '9:00', hora_fin: '10:00' });
  assert.equal(r.status, 201, r.body.message);
  const [[t]] = await db.query('SELECT sector_id, hora_inicio, hora_fin FROM turnos_riego WHERE id = ?', [r.body.turnoId]);
  assert.deepEqual(t, { sector_id: sector, hora_inicio: '09:00:00', hora_fin: '10:00:00' });

  const cruce = await crear({ ...base(), hora_inicio: '09:30', hora_fin: '11:00' });
  assert.equal(cruce.status, 409);
  assert.match(cruce.body.message, /09:00 a 10:00/);
  assert.equal((await crear({ ...base(), hora_inicio: '10:00', hora_fin: '11:00' })).status, 201, 'turno contiguo');
  assert.equal((await crear({ ...base(), hora_inicio: '12:00', hora_fin: '11:00' })).status, 400, 'cruce de medianoche de 23 horas');
  assert.equal((await crear({ ...base(), hora_inicio: '12:00', hora_fin: '12:00' })).status, 400, 'sin duración');
  assert.equal((await crear({ ...base(), dia_semana: 8, hora_inicio: '06:00', hora_fin: '07:00' })).status, 400);
});

test('un sector no puede tener dos turnos a la vez; otro sector sí', async () => {
  const cruce = await crear({ ...base(), hora_inicio: '09:30', hora_fin: '10:30' });
  assert.equal(cruce.status, 409);
  assert.match(cruce.body.message, /sector ya tiene un turno/);

  const r = await crear(delBajo(2, '09:30', '10:30'));
  assert.equal(r.status, 201, r.body.message);
});

test('el turno es del sector: no pide usuario ni lote y exige un sector activo', async () => {
  assert.equal((await crear({ dia_semana: 4, hora_inicio: '06:00', hora_fin: '07:00' })).status, 400, 'sin sector');
  assert.equal((await crear({ sector_id: 999999, dia_semana: 4, hora_inicio: '06:00', hora_fin: '07:00' })).status, 404);
  const [[turno]] = await db.query('SELECT persona_id, lote_id FROM turnos_riego LIMIT 1');
  assert.equal(turno.persona_id, null);
  assert.equal(turno.lote_id, null);
});

test('ya no existen turnos adicionales: el tipo y el costo no se aceptan ni generan cobros', async () => {
  const r = await crear({ ...base(), dia_semana: 5, tipo: 'ADICIONAL', costo: 5, hora_inicio: '06:00', hora_fin: '07:00' });
  assert.equal(r.status, 201, r.body.message);
  assert.equal(r.body.obligacionId, undefined);
  const [[{ cobros }]] = await db.query(
    "SELECT COUNT(*) AS cobros FROM obligaciones o JOIN conceptos_cobro c ON c.id = o.concepto_id WHERE c.codigo = 'TURNO_ADICIONAL'"
  );
  assert.equal(cobros, 0);
  const [columnas] = await db.query(
    "SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'turnos_riego' AND COLUMN_NAME = 'tipo'"
  );
  assert.equal(columnas.length, 0);
  const [[concepto]] = await db.query("SELECT activo FROM conceptos_cobro WHERE codigo = 'TURNO_ADICIONAL'");
  assert.equal(Boolean(concepto.activo), false);
});

test('editar conserva los campos omitidos y valida cruces con el horario final', async () => {
  const r = await crear({ ...base(), dia_semana: 3, hora_inicio: '14:00', hora_fin: '15:00' });
  assert.equal(r.status, 201);

  assert.equal((await editar(r.body.turnoId, { hora_fin: '16:00' })).status, 200);
  const [[t]] = await db.query('SELECT dia_semana, hora_inicio, hora_fin FROM turnos_riego WHERE id = ?', [r.body.turnoId]);
  assert.deepEqual(t, { dia_semana: 3, hora_inicio: '14:00:00', hora_fin: '16:00:00' });

  assert.equal((await editar(r.body.turnoId, { dia_semana: 2, hora_inicio: '09:30', hora_fin: '10:30' })).status, 409);
  assert.equal((await editar(r.body.turnoId, { hora_inicio: '17:00' })).status, 400, 'inicio después del fin guardado');
  assert.equal((await editar(999999, { hora_fin: '16:00' })).status, 404);
});

test('los turnos nocturnos cruzan la medianoche, suman su duración real y bloquean el día siguiente (H-13)', async () => {
  const nocturno = await crear({ ...base(), dia_semana: 6, hora_inicio: '22:00', hora_fin: '02:00' });
  assert.equal(nocturno.status, 201, nocturno.body.message);

  const cronograma = await request(app).get('/api/turnos/cronograma').set(auth(admin));
  const sabado = cronograma.body.data.find((s) => s.sector_nombre === 'La Jones Alta').dias[5].turnos;
  assert.equal(sabado.find((t) => t.id === nocturno.body.turnoId).duracion_minutos, 240);

  // Invade la madrugada del domingo y la noche del sábado, pero no más allá.
  assert.equal((await crear({ ...base(), dia_semana: 7, hora_inicio: '01:00', hora_fin: '01:30' })).status, 409, 'madrugada del día siguiente');
  assert.equal((await crear({ ...base(), dia_semana: 6, hora_inicio: '21:00', hora_fin: '22:30' })).status, 409, 'noche del mismo día');
  assert.equal((await crear({ ...base(), dia_semana: 7, hora_inicio: '02:00', hora_fin: '03:00' })).status, 201, 'contiguo al fin');
  assert.equal((await crear({ ...base(), dia_semana: 6, hora_inicio: '20:00', hora_fin: '22:00' })).status, 201, 'contiguo al inicio');

  // El domingo pasa al lunes de la semana siguiente.
  const domingoNoche = await crear({ ...base(), dia_semana: 7, hora_inicio: '23:00', hora_fin: '01:00' });
  assert.equal(domingoNoche.status, 201, domingoNoche.body.message);
  assert.equal((await crear({ ...base(), dia_semana: 1, hora_inicio: '00:30', hora_fin: '01:30' })).status, 409, 'lunes de madrugada');
});

test('eliminar desactiva el turno una sola vez', async () => {
  const r = await crear({ ...base(), dia_semana: 4, hora_inicio: '06:00', hora_fin: '07:00' });
  assert.equal((await request(app).delete(`/api/turnos/${r.body.turnoId}`).set(auth(admin))).status, 200);
  assert.equal((await request(app).delete(`/api/turnos/${r.body.turnoId}`).set(auth(admin))).status, 404);
  assert.equal((await request(app).get('/api/turnos?dia_semana=x').set(auth(admin))).status, 400);
});

test('el representante del sector se designa, se cambia y se quita; debe ser un usuario activo', async () => {
  const designar = (id, personaId, quien = admin) =>
    request(app).put(`/api/turnos/sectores/${id}/representante`).set(auth(quien)).send({ persona_id: personaId });

  assert.equal((await designar(sector, usuario.personaId, usuario)).status, 403, 'un usuario no designa');
  assert.equal((await designar(sector, 999999)).status, 404, 'persona inexistente');
  assert.equal((await designar(999999, usuario.personaId)).status, 404, 'sector inexistente');
  assert.equal((await request(app).put(`/api/turnos/sectores/${sector}/representante`).set(auth(admin)).send({})).status, 400);

  assert.equal((await designar(sector, usuario.personaId)).status, 200);
  const [[fila]] = await db.query('SELECT representante_persona_id FROM sectores WHERE id = ?', [sector]);
  assert.equal(fila.representante_persona_id, usuario.personaId);
  const [[auditoria]] = await db.query("SELECT accion FROM auditoria WHERE entidad = 'sectores' AND entidad_id = ? ORDER BY id DESC LIMIT 1", [sector]);
  assert.equal(auditoria.accion, 'MODIFICAR');

  const cronograma = await request(app).get('/api/turnos/cronograma').set(auth(admin));
  const alto = cronograma.body.data.find((s) => s.sector_id === sector);
  assert.equal(alto.representante_persona_id, usuario.personaId);
  assert.ok(alto.representante_nombre);
  assert.equal(alto.representante_cedula, usuario.cedula);

  assert.equal((await designar(sector, null)).status, 200);
  const [[quitado]] = await db.query('SELECT representante_persona_id FROM sectores WHERE id = ?', [sector]);
  assert.equal(quitado.representante_persona_id, null);

  await db.query("UPDATE personas SET estado = 'INACTIVO' WHERE id = ?", [vecino.personaId]);
  assert.equal((await designar(sector, vecino.personaId)).status, 404, 'persona inactiva');
  await db.query("UPDATE personas SET estado = 'ACTIVO' WHERE id = ?", [vecino.personaId]);
});

test('un usuario ve solo los turnos de los sectores donde tiene lotes o que representa', async () => {
  const propios = await request(app).get(`/api/turnos?persona_id=${vecino.personaId}`).set(auth(usuario));
  assert.equal(propios.status, 200);
  assert.ok(propios.body.data.length > 0);
  assert.ok(propios.body.data.every((t) => t.sector_id === sector), 'pidió a otro usuario y recibió los suyos');

  await db.query('UPDATE sectores SET representante_persona_id = ? WHERE id = ?', [usuario.personaId, sectorBajo]);
  const conRepresentacion = await request(app).get('/api/turnos').set(auth(usuario));
  assert.ok(conRepresentacion.body.data.some((t) => t.sector_id === sectorBajo), 've el sector que representa');
  await db.query('UPDATE sectores SET representante_persona_id = NULL WHERE id = ?', [sectorBajo]);
});

test('el cronograma completo, con el representante, es solo para la directiva', async () => {
  assert.equal((await request(app).get('/api/turnos/cronograma')).status, 401);
  assert.equal((await request(app).get('/api/turnos/cronograma').set(auth(usuario))).status, 403);

  const res = await request(app).get('/api/turnos/cronograma').set(auth(admin));
  assert.equal(res.status, 200);
  const alto = res.body.data.find((s) => s.sector_nombre === 'La Jones Alta');
  assert.equal(alto.dias.length, 7);
  assert.equal(alto.total_lotes, 1);
  assert.ok(alto.dias.flatMap((d) => d.turnos).length > 0);
});

test('el cronograma público muestra solo horarios por sector, sin datos personales', async () => {
  await request(app).put(`/api/turnos/sectores/${sector}/representante`).set(auth(admin)).send({ persona_id: usuario.personaId });
  const res = await request(app).get('/api/turnos/cronograma-publico');
  assert.equal(res.status, 200);
  const alto = res.body.data.find((s) => s.sector_nombre === 'La Jones Alta');
  assert.ok(alto.total_turnos > 0);
  assert.equal(alto.representante_nombre, undefined);
  for (const t of alto.dias.flatMap((d) => d.turnos)) {
    assert.deepEqual(Object.keys(t).sort(), ['duracion_minutos', 'hora_fin', 'hora_inicio', 'id']);
  }
  const json = JSON.stringify(res.body);
  for (const dato of [usuario.cedula, vecino.cedula, 'De Prueba']) assert.ok(!json.includes(dato), `expone ${dato}`);
  assert.equal((await request(app).get('/api/turnos/publicos/cronograma')).status, 404, 'sin rutas duplicadas');
});

test('un sector sin turnos aparece en el cronograma con sus días vacíos', async () => {
  const nuevo = await crearSector('La Jones Media');
  const res = await request(app).get('/api/turnos/cronograma-publico');
  const media = res.body.data.find((s) => s.sector_id === nuevo);
  assert.equal(media.total_turnos, 0);
  assert.equal(media.dias.length, 7);
});
