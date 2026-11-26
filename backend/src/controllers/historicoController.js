/**
 * Rutas del histórico (datos en papel), la caja previa al sistema y los deudores. Solo tesorería.
 * Toda escritura guarda su auditoría en la misma transacción.
 */
const db = require('../config/db');
const { conAuditoria } = require('../services/auditService');
const historicos = require('../services/historicosService');
const { deudores } = require('../services/deudoresService');
const s = require('../shared/schemas');
const {
  personaIdParam, historicoSchema, historicoQuery, ingresoPrevioSchema, motivoSchema
} = require('../schemas/finanzas');

/** Estado actual del histórico de un usuario (para llenar el formulario). */
async function getHistorico(req, res) {
  const { personaId } = personaIdParam.parse(req.params);
  const { anio } = historicoQuery.parse(req.query);
  return res.json({ status: 'OK', data: await historicos.consultarHistorico(db, personaId, anio) });
}

/** Guardar el histórico de un usuario: agua del año, acumulados de años anteriores y multas por mes. */
async function guardarHistorico(req, res) {
  const { personaId } = personaIdParam.parse(req.params);
  const datos = historicoSchema.parse(req.body);
  const cambios = await conAuditoria(req, (conexion) => historicos.guardarHistorico(conexion, {
    personaId,
    anio: datos.anio,
    valorHectarea: datos.valor_hectarea,
    lotes: datos.lotes,
    aguaAnterior: datos.agua_anterior,
    multas: { ASAMBLEA: datos.multas_asamblea, MINGA: datos.multas_minga }
  }), {
    accion: 'CREAR', entidad: 'historico_deudas', entidadId: personaId,
    detalle: {
      anio: datos.anio ?? null, lotes: datos.lotes, agua_anterior: datos.agua_anterior ?? null,
      multas_asamblea: datos.multas_asamblea ?? null, multas_minga: datos.multas_minga ?? null, valor_hectarea: datos.valor_hectarea ?? null
    }
  });
  return res.json({ status: 'OK', message: 'Histórico guardado correctamente.', data: cambios });
}

/** Deudores del agua y de las multas: resumen y detalle por usuario. */
async function getDeudores(req, res) {
  return res.json({ status: 'OK', data: await deudores(db) });
}

async function getIngresosPrevios(req, res) {
  return res.json({ status: 'OK', data: await historicos.listarIngresosPrevios(db) });
}

async function createIngresoPrevio(req, res) {
  const datos = ingresoPrevioSchema.parse(req.body);
  const id = await conAuditoria(req, (conexion) => historicos.registrarIngresoPrevio(conexion, datos, req.user.cuentaId), (nuevoId) => ({
    accion: 'CREAR', entidad: 'ingresos_previos', entidadId: nuevoId, detalle: datos
  }));
  return res.status(201).json({ status: 'OK', message: 'Caja previa registrada correctamente.', id });
}

async function anularIngresoPrevio(req, res) {
  const { id } = s.idParam.parse(req.params);
  const { motivo } = motivoSchema.parse(req.body);
  await conAuditoria(req, (conexion) => historicos.anularIngresoPrevio(conexion, { id, motivo, cuentaId: req.user.cuentaId }),
    ({ ingreso }) => ({ accion: 'ANULAR', entidad: 'ingresos_previos', entidadId: id, detalle: { motivo, valor: ingreso.valor } }));
  return res.json({ status: 'OK', message: 'Registro de caja previa anulado.' });
}

module.exports = { getHistorico, guardarHistorico, getDeudores, getIngresosPrevios, createIngresoPrevio, anularIngresoPrevio };
