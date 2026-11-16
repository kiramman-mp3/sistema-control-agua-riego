const db = require('../config/db');
const { registrarAuditoria } = require('../services/auditService');
const finanzas = require('../services/finanzasService');
const { personaPermitida } = require('../shared/roles');
const { withTransaction } = require('../shared/transaction');
const { hoy } = require('../shared/dates');
const { badRequest, notFound, conflict } = require('../shared/errors');
const { FORMATO_CODIGO_LOTE, normalizarCodigo, prefijoSector } = require('../utils/loteCodigo');
const { patronContiene } = require('../shared/sql');
const s = require('../shared/schemas');
const { z } = s;

/** Número opcional: '' y null se guardan como null. */
const numeroOpcional = (esquema) => z.preprocess((v) => (v === '' || v === null ? undefined : v), esquema.optional()).transform((v) => v ?? null);
const relacion = z.enum(['PROPIETARIO', 'REPRESENTANTE']).default('PROPIETARIO');

/** La superficie (en m²) es obligatoria: el pago anual de agua se calcula por hectárea. */
const MENSAJE_SUPERFICIE = 'La superficie del lote es obligatoria y debe ser mayor a cero (en m²).';
const superficieObligatoria = z.coerce.number({ error: MENSAJE_SUPERFICIE }).positive(MENSAJE_SUPERFICIE).max(10_000_000, 'La superficie no puede superar 10.000.000 m².');

/** Titularidad única: un lote pertenece al 100 % a un solo usuario. Se rechaza cualquier otro valor en lugar de ignorarlo. */
const PORCENTAJE_TITULARIDAD = 100;
const porcentajeTitularidad = z.coerce
  .number({ error: 'El porcentaje de propiedad debe ser 100.' })
  .refine((v) => v === PORCENTAJE_TITULARIDAD, 'Un lote pertenece al 100 % a un solo usuario; no se admite propiedad compartida.')
  .optional();

const sugerirQuery = z.object({ sector_id: z.coerce.number({ error: 'Seleccione un sector válido para sugerir el código.' }).int().positive('Seleccione un sector válido para sugerir el código.') });

const sectorSchema = z.object({
  nombre: z.string({ error: 'El nombre del sector es obligatorio.' }).trim().min(2, 'El nombre del sector es obligatorio.').max(100),
  descripcion: s.textoOpcional(255)
});

const lotesQuery = z.object({
  sector_id: s.id.optional(),
  persona_id: s.id.optional(),
  busqueda: z.string().trim().max(100).optional(),
  // Opcional: sin page se devuelve la lista completa (la usan los selectores de lote de los formularios).
  page: z.coerce.number().int().min(1).optional(),
  limit: s.paginacion.shape.limit
});

const loteSchema = z.object({
  sector_id: s.id,
  codigo: z.string({ error: 'El código del lote es obligatorio.' }).transform(normalizarCodigo)
    .refine((c) => FORMATO_CODIGO_LOTE.test(c), 'El código debe tener tres letras y de tres a ocho dígitos separados por un guion. Ejemplo: LJA-001.'),
  superficie_m2: superficieObligatoria,
  ancho_m: numeroOpcional(z.coerce.number().positive().max(100_000)),
  largo_m: numeroOpcional(z.coerce.number().positive().max(100_000)),
  latitud_aproximada: numeroOpcional(z.coerce.number().min(-90).max(90)),
  longitud_aproximada: numeroOpcional(z.coerce.number().min(-180).max(180)),
  radio_error_m: numeroOpcional(z.coerce.number().min(0).max(10_000)),
  referencia_ubicacion: s.textoOpcional(255),
  observacion: s.textoOpcional(255),
  persona_id: s.id.optional(),
  tipo_relacion: relacion,
  porcentaje: porcentajeTitularidad
});

const loteUpdateSchema = z.object({
  sector_id: s.id.optional(),
  codigo: z.string().transform(normalizarCodigo)
    .refine((c) => FORMATO_CODIGO_LOTE.test(c), 'El código debe tener tres letras y de tres a ocho dígitos separados por un guion. Ejemplo: LJA-001.').optional(),
  // Al editar puede omitirse (se conserva la actual), pero nunca vaciarse.
  superficie_m2: superficieObligatoria.optional(),
  ancho_m: numeroOpcional(z.coerce.number().positive().max(100_000)),
  largo_m: numeroOpcional(z.coerce.number().positive().max(100_000)),
  latitud_aproximada: numeroOpcional(z.coerce.number().min(-90).max(90)),
  longitud_aproximada: numeroOpcional(z.coerce.number().min(-180).max(180)),
  radio_error_m: numeroOpcional(z.coerce.number().min(0).max(10_000)),
  referencia_ubicacion: s.textoOpcional(255),
  observacion: s.textoOpcional(255)
});

const vincularSchema = z.object({
  persona_id: s.id,
  tipo_relacion: relacion,
  porcentaje: porcentajeTitularidad,
  observacion: s.textoOpcional(255)
});
const loteParam = z.object({ loteId: s.id });

async function verificarPersonaActiva(conexion, personaId) {
  const [filas] = await conexion.query("SELECT id, CONCAT(nombres, ' ', apellidos) AS nombre FROM personas WHERE id = ? AND estado = 'ACTIVO'", [personaId]);
  if (!filas.length) throw notFound('El usuario no existe o está inactivo.');
  return filas[0];
}

/** Próximo código libre del prefijo del sector (cuenta también lotes inactivos y de otros sectores). */
async function sugerirCodigo(req, res) {
  const { sector_id: sectorId } = sugerirQuery.parse(req.query);
  const [sectores] = await db.query('SELECT nombre FROM sectores WHERE id = ? AND activo = TRUE', [sectorId]);
  if (!sectores.length) throw notFound('El sector seleccionado no existe o está inactivo.');
  // Incluye lotes inactivos: sus códigos también están sujetos al UNIQUE global.
  const prefijo = prefijoSector(sectores[0].nombre);
  const [codigos] = await db.query('SELECT codigo FROM lotes WHERE codigo LIKE ?', [`${prefijo}-%`]);
  let consecutivo = 0;
  for (const lote of codigos) {
    const codigo = normalizarCodigo(lote.codigo);
    if (FORMATO_CODIGO_LOTE.test(codigo)) consecutivo = Math.max(consecutivo, Number(codigo.slice(4)));
  }
  if (consecutivo >= 99999999) throw conflict('Se agotaron los códigos para este prefijo.');
  return res.json({ status: 'OK', data: { codigo: `${prefijo}-${String(consecutivo + 1).padStart(3, '0')}` } });
}

/** Catálogo de sectores con el número de lotes activos y su superficie. */
async function getSectores(req, res) {
  const [sectores] = await db.query(
    `SELECT s.id, s.nombre, s.descripcion,
            COUNT(l.id) AS lotesCount,
            ROUND(COALESCE(SUM(l.superficie_m2), 0) / 10000, 2) AS superficieHa
     FROM sectores s
     LEFT JOIN lotes l ON l.sector_id = s.id AND l.activo = TRUE
     WHERE s.activo = TRUE
     GROUP BY s.id
     ORDER BY s.nombre ASC`
  );
  return res.json({ status: 'OK', data: sectores.map((x) => ({ ...x, lotesCount: Number(x.lotesCount), superficieHa: Number(x.superficieHa) })) });
}

async function createSector(req, res) {
  const { nombre, descripcion } = sectorSchema.parse(req.body);
  let sectorId;
  try {
    const [r] = await db.query('INSERT INTO sectores (nombre, descripcion) VALUES (?, ?)', [nombre, descripcion]);
    sectorId = r.insertId;
  } catch (error) {
    if (error.code === 'ER_DUP_ENTRY') throw conflict(`Ya existe el sector ${nombre}.`);
    throw error;
  }
  await registrarAuditoria({ cuentaId: req.user.cuentaId, accion: 'CREAR', entidad: 'sectores', entidadId: sectorId, ip: req.ip, detalle: { nombre } });
  return res.status(201).json({ status: 'OK', message: 'Sector creado exitosamente.', sectorId });
}

async function updateSector(req, res) {
  const { id } = s.idParam.parse(req.params);
  const { nombre, descripcion } = sectorSchema.parse(req.body);
  const [existentes] = await db.query('SELECT id FROM sectores WHERE id = ?', [id]);
  if (!existentes.length) throw notFound('El sector no existe.');
  try {
    await db.query('UPDATE sectores SET nombre = ?, descripcion = ? WHERE id = ?', [nombre, descripcion, id]);
  } catch (error) {
    if (error.code === 'ER_DUP_ENTRY') throw conflict(`Ya existe otro sector con el nombre ${nombre}.`);
    throw error;
  }
  await registrarAuditoria({ cuentaId: req.user.cuentaId, accion: 'ACTUALIZAR', entidad: 'sectores', entidadId: id, ip: req.ip, detalle: { nombre } });
  return res.json({ status: 'OK', message: 'Sector actualizado exitosamente.' });
}

async function deleteSector(req, res) {
  const { id } = s.idParam.parse(req.params);
  const [existentes] = await db.query('SELECT id, activo FROM sectores WHERE id = ?', [id]);
  if (!existentes.length) throw notFound('El sector no existe.');
  const [[{ lotesCount }]] = await db.query('SELECT COUNT(*) AS lotesCount FROM lotes WHERE sector_id = ? AND activo = TRUE', [id]);
  if (lotesCount > 0) throw conflict('No se puede eliminar el sector porque tiene lotes activos asignados.');
  const [[{ turnosCount }]] = await db.query(
    'SELECT COUNT(*) AS turnosCount FROM turnos_riego WHERE sector_id = ? AND estado = "ACTIVO"',
    [id]
  );
  if (turnosCount > 0) throw conflict('No se puede eliminar el sector porque tiene turnos de riego asociados.');

  await db.query('UPDATE sectores SET activo = FALSE WHERE id = ?', [id]);
  await registrarAuditoria({ cuentaId: req.user.cuentaId, accion: 'ELIMINAR', entidad: 'sectores', entidadId: id, ip: req.ip, detalle: { id } });
  return res.json({ status: 'OK', message: 'Sector eliminado exitosamente.' });
}

/** Lotes activos con su titular. Un usuario solo recibe los suyos. */
async function getLotes(req, res) {
  const filtros = lotesQuery.parse(req.query);
  const personaId = personaPermitida(req.user, filtros.persona_id);
  const condiciones = ['l.activo = TRUE'];
  const params = [];
  if (personaId) {
    condiciones.push('EXISTS (SELECT 1 FROM persona_lotes x WHERE x.lote_id = l.id AND x.persona_id = ?)');
    params.push(personaId);
  }
  if (filtros.sector_id) { condiciones.push('l.sector_id = ?'); params.push(filtros.sector_id); }
  if (filtros.busqueda) {
    condiciones.push('(l.codigo LIKE ? OR l.referencia_ubicacion LIKE ?)');
    const patron = patronContiene(filtros.busqueda);
    params.push(patron, patron);
  }

  const where = condiciones.join(' AND ');
  const paginado = filtros.page !== undefined;
  const [lotes] = await db.query(
    `SELECT l.id, l.sector_id, l.codigo, l.superficie_m2, l.ancho_m, l.largo_m,
            l.latitud_aproximada, l.longitud_aproximada, l.radio_error_m,
            l.referencia_ubicacion, l.observacion, l.activo, l.created_at,
            s.nombre AS sector_nombre,
            pl.tipo_relacion, pl.porcentaje,
            p.id AS propietario_id, p.cedula AS propietario_cedula,
            CONCAT(p.nombres, ' ', p.apellidos) AS propietario_nombre,
            CASE WHEN p.id IS NOT NULL THEN CONCAT(p.nombres, ' ', p.apellidos, ' (C.I. ', p.cedula, ')') ELSE 'Sin propietario asignado' END AS propietario,
            CONCAT(p.nombres, ' ', p.apellidos) AS propietarios
     FROM lotes l
     JOIN sectores s ON s.id = l.sector_id
     LEFT JOIN persona_lotes pl ON pl.lote_id = l.id
     LEFT JOIN personas p ON p.id = pl.persona_id
     WHERE ${where}
     ORDER BY s.nombre ASC, l.codigo ASC${paginado ? ' LIMIT ? OFFSET ?' : ''}`,
    paginado ? [...params, filtros.limit, (filtros.page - 1) * filtros.limit] : params
  );
  if (!paginado) return res.json({ status: 'OK', data: lotes });

  const [[{ total }]] = await db.query(`SELECT COUNT(*) AS total FROM lotes l WHERE ${where}`, params);
  return res.json({ status: 'OK', data: lotes, pagination: { total, page: filtros.page, limit: filtros.limit } });
}

/** Crear un lote y, si se indica, asignarle su titular en la misma transacción. */
async function createLote(req, res) {
  const datos = loteSchema.parse(req.body);
  let loteId;
  try {
    loteId = await withTransaction(async (conexion) => {
      const [sectores] = await conexion.query('SELECT id FROM sectores WHERE id = ? AND activo = TRUE', [datos.sector_id]);
      if (!sectores.length) throw notFound('El sector seleccionado no existe o está inactivo.');
      const [existentes] = await conexion.query('SELECT id FROM lotes WHERE codigo = ?', [datos.codigo]);
      if (existentes.length) throw conflict('Este código de lote ya está registrado. Solicite otra sugerencia o ingrese un código diferente.');
      if (datos.persona_id) await verificarPersonaActiva(conexion, datos.persona_id);

      const [r] = await conexion.query(
        `INSERT INTO lotes (sector_id, codigo, superficie_m2, ancho_m, largo_m, latitud_aproximada, longitud_aproximada, radio_error_m, referencia_ubicacion, observacion)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [datos.sector_id, datos.codigo, datos.superficie_m2, datos.ancho_m, datos.largo_m, datos.latitud_aproximada,
          datos.longitud_aproximada, datos.radio_error_m, datos.referencia_ubicacion, datos.observacion]
      );
      if (datos.persona_id) {
        await conexion.query(
          `INSERT INTO persona_lotes (persona_id, lote_id, tipo_relacion, porcentaje, fecha_desde) VALUES (?, ?, ?, ?, ?)`,
          [datos.persona_id, r.insertId, datos.tipo_relacion, PORCENTAJE_TITULARIDAD, hoy()]
        );
      }
      await registrarAuditoria({
        conexion, cuentaId: req.user.cuentaId, accion: 'CREAR', entidad: 'lotes', entidadId: r.insertId, ip: req.ip,
        detalle: { codigo: datos.codigo, sector_id: datos.sector_id, persona_id: datos.persona_id ?? null, latitud: datos.latitud_aproximada, longitud: datos.longitud_aproximada }
      });
      return r.insertId;
    });
  } catch (error) {
    // La restricción UNIQUE cubre la carrera entre sugerir/comprobar y el INSERT.
    if (error.code === 'ER_DUP_ENTRY') throw conflict('Este código de lote acaba de ser registrado. Solicite otra sugerencia.');
    throw error;
  }

  return res.status(201).json({ status: 'OK', message: 'Lote georreferenciado creado correctamente.', loteId });
}

async function updateLote(req, res) {
  const { id } = s.idParam.parse(req.params);
  const datos = s.soloEnviados(loteUpdateSchema.parse(req.body), req.body);

  // Se lee y se escribe el lote dentro de la misma transacción, bloqueado: dos ediciones simultáneas no se pisan
  // y el recálculo de cuotas compara con la superficie vigente. Si cambia la superficie, las cuotas anuales
  // pendientes se recalculan en esta misma transacción.
  const { cuotasRecalculadas, nuevoCodigo } = await withTransaction(async (conexion) => {
    const [existentes] = await conexion.query('SELECT * FROM lotes WHERE id = ? FOR UPDATE', [id]);
    if (!existentes.length) throw notFound('El lote no existe.');
    const loteActual = existentes[0];

    if (datos.sector_id && datos.sector_id !== loteActual.sector_id) {
      const [sectores] = await conexion.query('SELECT id FROM sectores WHERE id = ? AND activo = TRUE', [datos.sector_id]);
      if (!sectores.length) throw notFound('El sector seleccionado no existe o está inactivo.');
    }

    if (datos.codigo && datos.codigo !== loteActual.codigo) {
      const [dup] = await conexion.query('SELECT id FROM lotes WHERE codigo = ? AND id != ?', [datos.codigo, id]);
      if (dup.length) throw conflict('Este código de lote ya está registrado para otro lote.');
    }

    const nuevoSectorId = datos.sector_id !== undefined ? datos.sector_id : loteActual.sector_id;
    const nuevoCodigo = datos.codigo !== undefined ? datos.codigo : loteActual.codigo;
    const nuevaSuperficie = datos.superficie_m2 !== undefined ? datos.superficie_m2 : loteActual.superficie_m2;
    const nuevoAncho = datos.ancho_m !== undefined ? datos.ancho_m : loteActual.ancho_m;
    const nuevoLargo = datos.largo_m !== undefined ? datos.largo_m : loteActual.largo_m;
    const nuevaLatitud = datos.latitud_aproximada !== undefined ? datos.latitud_aproximada : loteActual.latitud_aproximada;
    const nuevaLongitud = datos.longitud_aproximada !== undefined ? datos.longitud_aproximada : loteActual.longitud_aproximada;
    const nuevoRadio = datos.radio_error_m !== undefined ? datos.radio_error_m : loteActual.radio_error_m;
    const nuevaReferencia = datos.referencia_ubicacion !== undefined ? datos.referencia_ubicacion : loteActual.referencia_ubicacion;
    const nuevaObservacion = datos.observacion !== undefined ? datos.observacion : loteActual.observacion;

    await conexion.query(
      `UPDATE lotes
       SET sector_id = ?, codigo = ?, superficie_m2 = ?, ancho_m = ?, largo_m = ?,
           latitud_aproximada = ?, longitud_aproximada = ?, radio_error_m = ?,
           referencia_ubicacion = ?, observacion = ?
       WHERE id = ?`,
      [nuevoSectorId, nuevoCodigo, nuevaSuperficie, nuevoAncho, nuevoLargo, nuevaLatitud, nuevaLongitud, nuevoRadio, nuevaReferencia, nuevaObservacion, id]
    );
    const recalculadas = Number(nuevaSuperficie) === Number(loteActual.superficie_m2)
      ? []
      : await finanzas.recalcularCuotasPendientesDeLote(conexion, { loteId: id, superficieM2: Number(nuevaSuperficie) });
    // Si se recalculan cuotas, su rastro se guarda con ellas o no se guarda nada.
    await registrarAuditoria({
      conexion,
      cuentaId: req.user.cuentaId,
      accion: 'ACTUALIZAR',
      entidad: 'lotes',
      entidadId: id,
      ip: req.ip,
      detalle: {
        codigo: nuevoCodigo, sector_id: nuevoSectorId,
        ...(recalculadas.length && {
          superficie_anterior_m2: Number(loteActual.superficie_m2), superficie_nueva_m2: Number(nuevaSuperficie), cuotasRecalculadas: recalculadas
        })
      }
    });
    return { cuotasRecalculadas: recalculadas, nuevoCodigo };
  });

  const aviso = cuotasRecalculadas.length
    ? ` Se recalcularon ${cuotasRecalculadas.length} cuota(s) anual(es) de agua pendiente(s) con la nueva superficie.`
    : '';
  return res.json({
    status: 'OK', message: `Lote actualizado exitosamente.${aviso}`, data: { id, codigo: nuevoCodigo },
    cuotasRecalculadas: cuotasRecalculadas.length ? cuotasRecalculadas : undefined
  });
}

/**
 * Eliminación física de un lote registrado por error. Solo se permite si no tiene cuotas anuales de agua (pagadas
 * o pendientes): borrarlo arrastraría ese historial financiero. Con cuotas, el lote se corrige con la edición.
 * Al borrarlo se pierde también su vínculo con el titular, que queda registrado en la auditoría.
 */
async function deleteLote(req, res) {
  const { id } = s.idParam.parse(req.params);
  await withTransaction(async (conexion) => {
    const [lotes] = await conexion.query('SELECT id, codigo, sector_id FROM lotes WHERE id = ? FOR UPDATE', [id]);
    if (!lotes.length) throw notFound('El lote no existe.');
    const lote = lotes[0];
    const [[{ cuotas }]] = await conexion.query('SELECT COUNT(*) AS cuotas FROM obligacion_anual_agua WHERE lote_id = ?', [id]);
    if (Number(cuotas) > 0) {
      throw conflict(`No se puede eliminar el lote ${lote.codigo} porque tiene ${cuotas} cuota(s) anual(es) de agua registradas. Corrija sus datos con Editar lote.`);
    }
    const [titulares] = await conexion.query('SELECT persona_id FROM persona_lotes WHERE lote_id = ?', [id]);
    await conexion.query('DELETE FROM lotes WHERE id = ?', [id]);
    await registrarAuditoria({
      conexion, cuentaId: req.user.cuentaId, accion: 'ELIMINAR', entidad: 'lotes', entidadId: id, ip: req.ip,
      detalle: { codigo: lote.codigo, sector_id: lote.sector_id, persona_id: titulares[0]?.persona_id ?? null }
    });
  });
  return res.json({ status: 'OK', message: 'Lote eliminado exitosamente.' });
}

/**
 * Asignar o transferir la titularidad de un lote (un lote tiene un solo titular).
 * La transferencia queda en la auditoría con el titular anterior y la fecha desde la que tenía el lote.
 */
async function linkPersonaLote(req, res) {
  const { loteId } = loteParam.parse(req.params);
  const datos = vincularSchema.parse(req.body);

  const resultado = await withTransaction(async (conexion) => {
    const [lotes] = await conexion.query('SELECT id, codigo, activo FROM lotes WHERE id = ? FOR UPDATE', [loteId]);
    if (!lotes.length || !lotes[0].activo) throw notFound('El lote no existe o está inactivo.');
    const nuevo = await verificarPersonaActiva(conexion, datos.persona_id);
    const [previos] = await conexion.query('SELECT persona_id, tipo_relacion, fecha_desde FROM persona_lotes WHERE lote_id = ? FOR UPDATE', [loteId]);
    const anterior = previos[0] ?? null;
    if (anterior && Number(anterior.persona_id) === datos.persona_id && anterior.tipo_relacion === datos.tipo_relacion) {
      throw badRequest('El lote ya pertenece a este usuario.');
    }

    await conexion.query('DELETE FROM persona_lotes WHERE lote_id = ?', [loteId]);
    await conexion.query(
      `INSERT INTO persona_lotes (persona_id, lote_id, tipo_relacion, porcentaje, fecha_desde, observacion) VALUES (?, ?, ?, ?, ?, ?)`,
      [datos.persona_id, loteId, datos.tipo_relacion, PORCENTAJE_TITULARIDAD, hoy(), datos.observacion]
    );
    // La deuda del agua sigue al lote: las cuotas anuales pendientes pasan al nuevo titular.
    const deudaTransferida = await finanzas.transferirDeudaAnualDeLote(conexion, { loteId, personaId: datos.persona_id });
    // El traspaso mueve deuda: su auditoría va en la misma transacción.
    await registrarAuditoria({
      conexion,
      cuentaId: req.user.cuentaId,
      accion: anterior ? 'TRANSFERIR' : 'CREAR',
      entidad: 'persona_lotes', entidadId: loteId, ip: req.ip,
      detalle: {
        lote: lotes[0].codigo,
        anterior: anterior && { persona_id: anterior.persona_id, tipo_relacion: anterior.tipo_relacion, desde: anterior.fecha_desde },
        nuevo: { persona_id: datos.persona_id, tipo_relacion: datos.tipo_relacion },
        deudaTransferida: deudaTransferida.obligaciones.length
          ? { obligaciones: deudaTransferida.obligaciones.map(({ id, anio, valor }) => ({ id, anio, valor })), total: deudaTransferida.total }
          : undefined
      }
    });
    return { lote: lotes[0], nuevo, anterior, deudaTransferida };
  });
  const { obligaciones: deuda, total: deudaTotal } = resultado.deudaTransferida;
  const avisoDeuda = deuda.length
    ? ` ${deuda.length} cuota(s) anual(es) de agua pendiente(s) del lote (total $${deudaTotal.toFixed(2)}) pasaron al nuevo titular.`
    : '';
  const message = resultado.anterior
    ? `Titularidad transferida a ${resultado.nuevo.nombre}.${avisoDeuda}`
    : 'Titularidad asignada correctamente. El lote ahora pertenece al usuario seleccionado.';
  return res.json({
    status: 'OK',
    message,
    deudaTransferida: deuda.length ? { obligaciones: deuda.map(({ id, anio, valor }) => ({ id, anio, valor })), total: deudaTotal } : undefined
  });
}

/** Cuotas anuales de agua pendientes de un lote: lo que pasaría al nuevo titular si se transfiere. */
async function getDeudaAguaLote(req, res) {
  const { loteId } = loteParam.parse(req.params);
  const [lotes] = await db.query('SELECT id, codigo FROM lotes WHERE id = ?', [loteId]);
  if (!lotes.length) throw notFound('El lote no existe.');
  const deuda = await finanzas.deudaAnualPendienteDeLote(db, loteId);
  const data = { lote: lotes[0].codigo, total: deuda.total, obligaciones: deuda.obligaciones.map(({ id, anio, valor }) => ({ id, anio, valor })) };
  return res.json({ status: 'OK', data });
}

module.exports = {
  sugerirCodigo,
  getSectores,
  createSector,
  updateSector,
  deleteSector,
  getLotes,
  createLote,
  updateLote,
  deleteLote,
  linkPersonaLote,
  getDeudaAguaLote
};
