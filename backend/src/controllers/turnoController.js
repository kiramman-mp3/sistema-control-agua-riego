const db = require('../config/db');
const { registrarAuditoria } = require('../services/auditService');
const turnos = require('../services/turnosService');
const { withTransaction } = require('../shared/transaction');
const { personaPermitida } = require('../shared/roles');
const s = require('../shared/schemas');
const { z } = s;

const dia = z.coerce.number({ error: 'Indique el día de la semana.' }).int()
  .min(1, 'El día de la semana debe estar entre 1 (lunes) y 7 (domingo).')
  .max(7, 'El día de la semana debe estar entre 1 (lunes) y 7 (domingo).');
const horarioValido = (d) => !d.hora_inicio || !d.hora_fin || turnos.horarioValido(d.hora_inicio, d.hora_fin);
const errorHorario = { path: ['hora_fin'], message: turnos.MENSAJE_HORARIO };

const filtrosQuery = z.object({
  persona_id: s.id.optional(),
  sector_id: s.id.optional(),
  dia_semana: dia.optional()
});

const crearSchema = z.object({
  sector_id: s.id,
  dia_semana: dia,
  hora_inicio: s.hora,
  hora_fin: s.hora,
  vigencia_desde: s.fechaOpcional,
  observacion: s.textoOpcional(255)
}).refine(horarioValido, errorHorario);

const representanteSchema = z.object({ persona_id: s.id.nullable() });

const actualizarSchema = z.object({
  sector_id: s.id.optional(),
  dia_semana: dia.optional(),
  hora_inicio: s.hora.optional(),
  hora_fin: s.hora.optional(),
  observacion: z.preprocess((v) => (typeof v === 'string' && !v.trim() ? null : v), z.string().trim().max(255).nullish())
}).refine(horarioValido, errorHorario);

/**
 * Turnos activos de los sectores. La directiva ve todos; un usuario solo los de los sectores donde tiene
 * lotes o de los que es representante.
 */
async function getTurnos(req, res) {
  const filtros = filtrosQuery.parse(req.query);
  const personaId = personaPermitida(req.user, filtros.persona_id);
  const condiciones = ["t.estado = 'ACTIVO'", 's.activo = TRUE'];
  const params = [];
  if (filtros.dia_semana) { condiciones.push('t.dia_semana = ?'); params.push(filtros.dia_semana); }
  if (filtros.sector_id) { condiciones.push('t.sector_id = ?'); params.push(filtros.sector_id); }
  if (personaId) {
    condiciones.push(`(s.representante_persona_id = ? OR s.id IN (
      SELECT l.sector_id FROM lotes l JOIN persona_lotes pl ON pl.lote_id = l.id
      WHERE pl.persona_id = ? AND l.activo = TRUE))`);
    params.push(personaId, personaId);
  }

  const [filas] = await db.query(
    `SELECT t.id, t.sector_id, t.dia_semana, t.hora_inicio, t.hora_fin,
            t.vigencia_desde, t.vigencia_hasta, t.estado, t.observacion,
            s.nombre AS sector_nombre, s.representante_persona_id,
            CONCAT(p.nombres, ' ', p.apellidos) AS representante_nombre
     FROM turnos_riego t
     JOIN sectores s ON s.id = t.sector_id
     LEFT JOIN personas p ON p.id = s.representante_persona_id
     WHERE ${condiciones.join(' AND ')}
     ORDER BY t.dia_semana ASC, t.hora_inicio ASC`,
    params
  );
  return res.json({ status: 'OK', data: filas });
}

/** Cronograma completo de riego (con el representante de cada sector) agrupado por sectores y días. Solo la directiva. */
async function getCronogramaPorSectores(req, res) {
  const { sector_id: sectorId, dia_semana: diaSemana } = filtrosQuery.parse(req.query);
  return res.json({ status: 'OK', data: await turnos.cronograma(db, { sectorId, diaSemana, completo: true }) });
}

/** Cronograma público: horarios por sector, sin nombres ni cédulas. */
async function getCronogramaPublico(req, res) {
  const { sector_id: sectorId, dia_semana: diaSemana } = filtrosQuery.parse(req.query);
  return res.json({ status: 'OK', data: await turnos.cronograma(db, { sectorId, diaSemana, completo: false }) });
}

/** Crear un turno semanal del sector sin cruces de horario. */
async function createTurno(req, res) {
  const datos = crearSchema.parse(req.body);
  const { turnoId } = await withTransaction((conexion) => turnos.crearTurno(conexion, datos));

  await registrarAuditoria({
    cuentaId: req.user.cuentaId, accion: 'CREAR', entidad: 'turnos_riego', entidadId: turnoId, ip: req.ip, detalle: datos
  });
  return res.status(201).json({ status: 'OK', message: 'Turno de agua creado correctamente.', turnoId });
}

/** Actualizar un turno; los campos omitidos conservan su valor. */
async function updateTurno(req, res) {
  const { id } = s.idParam.parse(req.params);
  const cambios = actualizarSchema.parse(req.body);
  const { antes, despues } = await withTransaction((conexion) => turnos.actualizarTurno(conexion, id, cambios));

  await registrarAuditoria({
    cuentaId: req.user.cuentaId, accion: 'MODIFICAR', entidad: 'turnos_riego', entidadId: id, ip: req.ip,
    detalle: {
      antes: { sector_id: antes.sector_id, dia_semana: antes.dia_semana, hora_inicio: antes.hora_inicio, hora_fin: antes.hora_fin },
      despues
    }
  });
  return res.json({ status: 'OK', message: 'Turno de agua actualizado correctamente.' });
}

/** Desactivar un turno (se conserva como historial). */
async function deleteTurno(req, res) {
  const { id } = s.idParam.parse(req.params);
  await withTransaction((conexion) => turnos.desactivarTurno(conexion, id));
  await registrarAuditoria({ cuentaId: req.user.cuentaId, accion: 'ELIMINAR', entidad: 'turnos_riego', entidadId: id, ip: req.ip, detalle: { id } });
  return res.json({ status: 'OK', message: 'Turno de agua eliminado con éxito.' });
}

/** Designar (o quitar, con persona_id null) al representante del sector que recibe el turno de agua. */
async function setRepresentante(req, res) {
  const { id } = s.idParam.parse(req.params);
  const { persona_id: personaId } = representanteSchema.parse(req.body);
  const { sector, anterior } = await withTransaction((conexion) => turnos.asignarRepresentante(conexion, id, personaId));

  await registrarAuditoria({
    cuentaId: req.user.cuentaId, accion: 'MODIFICAR', entidad: 'sectores', entidadId: id, ip: req.ip,
    detalle: { sector: sector.nombre, representante_anterior: anterior, representante: personaId }
  });
  return res.json({ status: 'OK', message: personaId ? 'Representante del sector designado correctamente.' : 'Se quitó el representante del sector.' });
}

module.exports = {
  getTurnos,
  setRepresentante,
  getCronogramaPorSectores,
  getCronogramaPublico,
  createTurno,
  updateTurno,
  deleteTurno
};
