const db = require('../config/db');
const { registrarAuditoria } = require('../services/auditService');
const finanzas = require('../services/finanzasService');
const { hoy } = require('../shared/dates');
// Las altas y cambios de usuarios y cuentas guardan su auditoría dentro de la misma transacción.
const { withTransaction } = require('../shared/transaction');
const { generarPasswordTemporal, hashPassword } = require('../shared/passwords');
const { ROLES, ROLES_DIRECTIVA, esAdmin, esTesorero } = require('../shared/roles');
const { badRequest, forbidden, notFound, conflict } = require('../shared/errors');
const { aCentavos, aDolares } = require('../shared/money');
const { patronContiene } = require('../shared/sql');
const s = require('../shared/schemas');
const { z } = s;

const datosPersona = {
  nombres: z.string().trim().min(1, 'Los nombres son obligatorios.').max(100),
  apellidos: z.string().trim().min(1, 'Los apellidos son obligatorios.').max(100),
  direccion: s.textoOpcional(255),
  telefono: s.telefono,
  celular: s.celular,
  email: s.email,
  fecha_nacimiento: s.fechaNacimientoOpcional
};

const rolCodigo = z.enum([ROLES.ADMIN, ROLES.TESORERO, ROLES.USUARIO]);

const listarSchema = s.paginacion.extend({
  busqueda: z.string().trim().max(100).optional(),
  estado: z.enum(['ACTIVO', 'INACTIVO']).optional(),
  sector_id: s.id.optional(),
  // Por defecto el padrón no muestra a los usuarios eliminados (ocultos); `solo` lista únicamente a esos.
  ocultos: z.enum(['solo']).optional()
});

const crearSchema = z.object({
  cedula: s.cedula,
  ...datosPersona,
  crearCuenta: z.boolean().default(false),
  rol: rolCodigo.default(ROLES.USUARIO)
});

const actualizarSchema = z.object({
  cedula: s.cedula.optional(),
  ...datosPersona,
  estado: z.enum(['ACTIVO', 'INACTIVO']).optional()
});

const cuentaCrearSchema = z.object({ rol: rolCodigo.default(ROLES.USUARIO) });
const cuentaActualizarSchema = z.object({
  rol: rolCodigo.optional(),
  estado: z.enum(['ACTIVA', 'BLOQUEADA', 'INACTIVA']).optional()
}).refine((d) => d.rol || d.estado, 'Indique el rol o el estado a modificar.');

async function idRol(conexion, codigo) {
  const [rows] = await conexion.query('SELECT id FROM roles WHERE codigo = ? AND activo = TRUE', [codigo]);
  if (!rows.length) throw badRequest(`El rol ${codigo} no está configurado.`);
  return rows[0].id;
}

/**
 * Exige que quede al menos otro administrador efectivo (cuenta ACTIVA, rol ADMIN o TESORERO y persona ACTIVA)
 * además de `personaId`. Bloquea esas filas, así dos cambios simultáneos no pueden dejar a la Junta
 * sin administrador.
 */
async function exigirOtroAdministrador(conexion, personaId, mensaje) {
  const [otros] = await conexion.query(
    `SELECT c.id FROM cuentas c
     JOIN roles r ON r.id = c.rol_id
     JOIN personas p ON p.id = c.persona_id
     WHERE r.codigo IN (?) AND c.estado = 'ACTIVA' AND p.estado = 'ACTIVO' AND c.persona_id <> ?
     FOR UPDATE`,
    [ROLES_DIRECTIVA, personaId]
  );
  if (!otros.length) throw conflict(mensaje);
}

/**
 * El rol de tesorero lo gobierna el propio tesorero: otra cuenta de la directiva no puede tocar la cuenta de un
 * tesorero (cambiar su rol o estado, restablecer su contraseña) ni conceder
 * el rol. La única excepción es designar al primer tesorero cuando no hay ninguno activo.
 */
async function exigirPermisoSobreTesorero(conexion, usuario, { cuenta = null, rolNuevo = null } = {}) {
  if (esTesorero(usuario)) return;
  if (cuenta?.rol === ROLES.TESORERO) throw forbidden('Solo el tesorero puede modificar la cuenta del tesorero.');
  if (rolNuevo !== ROLES.TESORERO) return;
  const [[{ activos }]] = await conexion.query(
    `SELECT COUNT(*) AS activos FROM cuentas c JOIN roles r ON r.id = c.rol_id
     JOIN personas p ON p.id = c.persona_id
     WHERE r.codigo = 'TESORERO' AND c.estado = 'ACTIVA' AND p.estado = 'ACTIVO'`
  );
  if (Number(activos) > 0) throw forbidden('Solo el tesorero puede designar a otro tesorero.');
}

async function cuentaDePersona(conexion, personaId, { bloquear = false } = {}) {
  const [rows] = await conexion.query(
    `SELECT c.id, c.estado, r.codigo AS rol FROM cuentas c JOIN roles r ON r.id = c.rol_id
     WHERE c.persona_id = ?${bloquear ? ' FOR UPDATE' : ''}`,
    [personaId]
  );
  return rows[0] || null;
}

/** Conflicto por cédula repetida; si la tiene un usuario oculto, indica que debe restaurarlo en vez de registrarlo de nuevo. */
function cedulaOcupada(existente, cedula, quien) {
  if (existente.oculta_en) {
    return conflict(
      `La cédula ${cedula} pertenece a un usuario eliminado (oculto). Restáurelo desde "Ver eliminados" en vez de registrarlo de nuevo.`,
      { codigo: 'PERSONA_OCULTA', personaId: existente.id }
    );
  }
  return conflict(`Ya existe ${quien} con la cédula ${cedula}.`);
}

/** Listar y buscar usuarios (directiva) con filtro por sector geográfico. */
async function getPersonas(req, res) {
  const { busqueda, estado, sector_id, ocultos, page, limit } = listarSchema.parse(req.query);
  const offset = (page - 1) * limit;

  let where = ocultos === 'solo' ? ' WHERE p.oculta_en IS NOT NULL' : ' WHERE p.oculta_en IS NULL';
  const params = [];
  if (estado) {
    where += ' AND p.estado = ?';
    params.push(estado);
  }
  if (sector_id) {
    where += ' AND p.id IN (SELECT pl.persona_id FROM persona_lotes pl JOIN lotes l ON l.id = pl.lote_id WHERE l.sector_id = ?)';
    params.push(sector_id);
  }
  if (busqueda) {
    where += ' AND (p.cedula LIKE ? OR p.nombres LIKE ? OR p.apellidos LIKE ? OR CONCAT(p.nombres, \' \', p.apellidos) LIKE ? OR CONCAT(p.apellidos, \' \', p.nombres) LIKE ?)';
    const term = patronContiene(busqueda);
    params.push(term, term, term, term, term);
  }

  const [personas] = await db.query(
    `SELECT p.id, p.cedula, p.nombres, p.apellidos, p.direccion, p.telefono, p.celular, p.email, p.fecha_nacimiento,
            p.estado, p.created_at, p.oculta_en,
            (SELECT COUNT(*) FROM persona_lotes pl WHERE pl.persona_id = p.id) AS lotes_count,
            (SELECT GROUP_CONCAT(DISTINCT s.nombre ORDER BY s.nombre SEPARATOR ', ')
             FROM persona_lotes pl
             JOIN lotes l ON l.id = pl.lote_id
             JOIN sectores s ON s.id = l.sector_id
             WHERE pl.persona_id = p.id) AS sector_nombre,
            c.estado AS cuenta_estado, r.codigo AS rol
     FROM personas p
     LEFT JOIN cuentas c ON c.persona_id = p.id
     LEFT JOIN roles r ON r.id = c.rol_id
     ${where}
     ORDER BY p.apellidos ASC, p.nombres ASC LIMIT ? OFFSET ?`,
    [...params, limit, offset]
  );
  const [[{ total }]] = await db.query(`SELECT COUNT(*) AS total FROM personas p${where}`, params);

  // Hectáreas de sus lotes y valor anual del agua que le corresponde con la tarifa por hectárea vigente hoy.
  const anual = await finanzas.valorAnualPorPersona(db, personas.map((p) => p.id), hoy());
  for (const p of personas) {
    const fila = anual.get(Number(p.id));
    p.hectareas_total = fila.hectareas;
    p.valor_anual_agua = fila.valorAnual;
  }

  return res.json({ status: 'OK', data: personas, pagination: { total, page, limit } });
}

/** Detalle de un usuario: la directiva ve a cualquiera; un usuario solo a sí mismo. */
async function getPersonaById(req, res) {
  const { id } = s.idParam.parse(req.params);
  if (!esAdmin(req.user) && req.user.personaId !== id) {
    throw forbidden('Solo puede consultar su propia información.');
  }

  const [rows] = await db.query(
    `SELECT p.*, c.estado AS cuenta_estado, c.debe_cambiar_password, c.ultimo_acceso, r.codigo AS rol
     FROM personas p
     LEFT JOIN cuentas c ON c.persona_id = p.id
     LEFT JOIN roles r ON r.id = c.rol_id
     WHERE p.id = ?`,
    [id]
  );
  if (!rows.length) throw notFound('Usuario no encontrado.');

  const [lotes] = await db.query(
    `SELECT l.id, l.sector_id, l.codigo, l.superficie_m2, l.ancho_m, l.largo_m,
            l.latitud_aproximada, l.longitud_aproximada, l.referencia_ubicacion,
            s.nombre AS sector_nombre, pl.tipo_relacion, pl.porcentaje
     FROM persona_lotes pl
     JOIN lotes l ON l.id = pl.lote_id
     JOIN sectores s ON s.id = l.sector_id
     WHERE pl.persona_id = ?`,
    [id]
  );

  // Turnos de los sectores donde el usuario tiene lotes o a los que representa.
  const [turnos] = await db.query(
    `SELECT t.id, t.dia_semana, t.hora_inicio, t.hora_fin, t.estado, t.observacion,
            s.nombre AS sector_nombre, (s.representante_persona_id = ?) AS es_representante
     FROM turnos_riego t
     JOIN sectores s ON s.id = t.sector_id
     WHERE t.estado = 'ACTIVO' AND s.activo = TRUE AND (s.representante_persona_id = ? OR s.id IN (
       SELECT l.sector_id FROM lotes l JOIN persona_lotes pl ON pl.lote_id = l.id
       WHERE pl.persona_id = ? AND l.activo = TRUE))
     ORDER BY t.dia_semana ASC, t.hora_inicio ASC`,
    [id, id, id]
  );

  const [obligaciones] = await db.query(
    `SELECT o.id, o.periodo_anio, o.periodo_mes, o.fecha_emision, o.fecha_vencimiento,
            o.valor, o.estado, o.observacion, c.codigo AS concepto_codigo, c.nombre AS concepto_nombre
     FROM obligaciones o
     JOIN conceptos_cobro c ON c.id = o.concepto_id
     WHERE o.persona_id = ? AND o.estado = 'PENDIENTE'
     ORDER BY o.fecha_emision DESC`,
    [id]
  );

  const [obligacionesAnuales] = await db.query(
    `SELECT id, periodo_anio, valor_total, estado, fecha_emision, fecha_vencimiento
     FROM obligacion_anual_agua WHERE persona_id = ? AND estado = 'PENDIENTE' ORDER BY periodo_anio`,
    [id]
  );

  return res.json({ status: 'OK', persona: rows[0], lotes, turnos, obligaciones, obligacionesAnuales });
}

/** Estado de cuenta (deudas y pagos) por cédula: la directiva o el propio usuario. */
async function consultaPublicaPorCedula(req, res) {
  const cedula = z.string().trim().regex(/^\d{10}$/, 'Cédula inválida.').parse(req.params.cedula);
  if (!esAdmin(req.user) && req.user.cedula !== cedula) {
    throw forbidden('Solo puede consultar sus propias deudas.');
  }

  const [personaRows] = await db.query('SELECT id, cedula, nombres, apellidos, estado FROM personas WHERE cedula = ?', [cedula]);
  if (!personaRows.length) throw notFound('No se encontró ningún usuario registrado con la cédula ingresada.');
  const persona = personaRows[0];

  const [lotesRows] = await db.query(
    `SELECT l.codigo AS lote_codigo, s.nombre AS sector_nombre
     FROM persona_lotes pl
     JOIN lotes l ON l.id = pl.lote_id
     JOIN sectores s ON s.id = l.sector_id
     WHERE pl.persona_id = ? ORDER BY l.codigo`,
    [persona.id]
  );
  const lotes = lotesRows.map((l) => ({ codigo: l.lote_codigo, sector: l.sector_nombre }));
  // `sector` y `loteCodigo` conservan el primer lote para los clientes anteriores a `lotes`.
  const loteInfo = lotesRows[0] || { lote_codigo: 'N/A', sector_nombre: 'Sin sector asignado' };

  const [obligaciones] = await db.query(
    `SELECT o.id, o.periodo_anio, o.periodo_mes, o.fecha_emision, o.valor, o.estado, o.observacion,
            c.nombre AS concepto_nombre, c.codigo AS concepto_codigo,
            (SELECT pd.pago_id
             FROM pago_detalles pd
             JOIN pagos p ON p.id = pd.pago_id AND p.estado = 'VIGENTE'
             WHERE pd.obligacion_id = o.id
             ORDER BY p.id DESC LIMIT 1) AS pago_id
     FROM obligaciones o
     JOIN conceptos_cobro c ON c.id = o.concepto_id
     WHERE o.persona_id = ? AND o.estado <> 'ANULADA'
     ORDER BY o.estado DESC, o.fecha_emision DESC`,
    [persona.id]
  );

  // El agua se cobra una vez al año por cada lote: sus obligaciones se muestran junto a multas y otros cobros.
  const [anuales] = await db.query(
    `SELECT o.id, o.periodo_anio, o.valor_total, o.estado, o.fecha_emision, o.lote_id,
            l.codigo AS lote_codigo,
            (SELECT d.pago_anual_agua_id FROM pago_anual_agua_detalle d
             JOIN pago_anual_agua p ON p.id = d.pago_anual_agua_id AND p.estado = 'VIGENTE'
             WHERE d.obligacion_anual_agua = o.id
             ORDER BY d.pago_anual_agua_id DESC LIMIT 1) AS pago_anual_id
     FROM obligacion_anual_agua o
     LEFT JOIN lotes l ON l.id = o.lote_id
     WHERE o.persona_id = ? AND o.estado <> 'ANULADA'
     ORDER BY o.periodo_anio DESC, l.codigo ASC`,
    [persona.id]
  );

  const deudas = [
    ...anuales.map((o) => ({
      id: o.id,
      tipo: 'AGUA_ANUAL',
      concepto: o.lote_codigo ? `Pago anual de agua (Lote ${o.lote_codigo})` : 'Pago anual de agua',
      conceptoCodigo: 'AGUA_ANUAL',
      anio: o.periodo_anio,
      mes: null,
      periodo: o.lote_codigo ? `Año ${o.periodo_anio} · Lote ${o.lote_codigo}` : `Año ${o.periodo_anio}`,
      valor: Number(o.valor_total),
      estado: o.estado,
      fechaEmision: o.fecha_emision,
      pagoId: null,
      pagoAnualId: o.pago_anual_id || null
    })),
    ...obligaciones.map((o) => ({
      id: o.id,
      tipo: 'OBLIGACION',
      concepto: o.concepto_nombre,
      conceptoCodigo: o.concepto_codigo,
      anio: o.periodo_anio || Number(String(o.fecha_emision).slice(0, 4)),
      mes: o.periodo_mes,
      periodo: o.periodo_mes ? `Mes ${o.periodo_mes}` : (o.observacion || 'Cuota/Multa'),
      valor: Number(o.valor),
      estado: o.estado,
      fechaEmision: o.fecha_emision,
      pagoId: o.pago_id || null,
      pagoAnualId: null
    }))
  ];
  const totalPendiente = aDolares(deudas.filter((d) => d.estado === 'PENDIENTE').reduce((suma, d) => suma + aCentavos(d.valor), 0));

  return res.json({
    status: 'OK',
    resultado: {
      cedula: persona.cedula,
      nombres: `${persona.nombres} ${persona.apellidos}`,
      sector: loteInfo.sector_nombre,
      loteCodigo: loteInfo.lote_codigo,
      lotes,
      totalPendiente,
      deudas
    }
  });
}

async function crearCuentaEnTransaccion(conexion, { personaId, rol, creadaPor }) {
  const passwordTemporal = generarPasswordTemporal();
  await conexion.query(
    `INSERT INTO cuentas (persona_id, rol_id, password_hash, debe_cambiar_password, estado, creada_por_cuenta_id)
     VALUES (?, ?, ?, TRUE, 'ACTIVA', ?)`,
    [personaId, await idRol(conexion, rol), await hashPassword(passwordTemporal), creadaPor]
  );
  return passwordTemporal;
}

/**
 * Registrar usuario y, opcionalmente, su cuenta de acceso.
 * La contraseña temporal se devuelve una sola vez para entregarla al usuario.
 */
async function createPersona(req, res) {
  const datos = crearSchema.parse(req.body);

  const resultado = await withTransaction(async (conexion) => {
    const [existe] = await conexion.query('SELECT id, oculta_en FROM personas WHERE cedula = ?', [datos.cedula]);
    if (existe.length) throw cedulaOcupada(existe[0], datos.cedula, 'un usuario registrado');

    const [insert] = await conexion.query(
      `INSERT INTO personas (cedula, nombres, apellidos, direccion, telefono, celular, email, fecha_nacimiento)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [datos.cedula, datos.nombres, datos.apellidos, datos.direccion, datos.telefono, datos.celular, datos.email, datos.fecha_nacimiento]
    );
    if (datos.crearCuenta) await exigirPermisoSobreTesorero(conexion, req.user, { rolNuevo: datos.rol });
    const passwordTemporal = datos.crearCuenta
      ? await crearCuentaEnTransaccion(conexion, { personaId: insert.insertId, rol: datos.rol, creadaPor: req.user.cuentaId })
      : null;
    await registrarAuditoria({
      conexion, cuentaId: req.user.cuentaId, accion: 'CREAR', entidad: 'personas', entidadId: insert.insertId, ip: req.ip,
      detalle: { cedula: datos.cedula, crearCuenta: datos.crearCuenta, rol: datos.crearCuenta ? datos.rol : null }
    });
    return { personaId: insert.insertId, passwordTemporal };
  });

  return res.status(201).json({
    status: 'OK',
    message: 'Usuario registrado exitosamente.',
    personaId: resultado.personaId,
    ...(resultado.passwordTemporal ? { passwordTemporal: resultado.passwordTemporal } : {})
  });
}

/** Actualizar datos personales de un usuario (incluyendo corrección auditada de cédula). */
async function updatePersona(req, res) {
  const { id } = s.idParam.parse(req.params);
  const datos = actualizarSchema.parse(req.body);

  await withTransaction(async (conexion) => {
    const [personaRows] = await conexion.query('SELECT id, cedula, estado, oculta_en FROM personas WHERE id = ? FOR UPDATE', [id]);
    if (!personaRows.length) throw notFound('Usuario no encontrado.');
    const personaActual = personaRows[0];
    if (personaActual.oculta_en) throw conflict('El usuario está eliminado (oculto). Restáurelo para poder modificarlo.', { codigo: 'PERSONA_OCULTA', personaId: id });
    const estadoActual = personaActual.estado;
    const nuevoEstado = datos.estado ?? estadoActual;
    const nuevaCedula = datos.cedula ? datos.cedula.trim() : personaActual.cedula;

    if (nuevaCedula !== personaActual.cedula) {
      const [existeCedula] = await conexion.query('SELECT id, oculta_en FROM personas WHERE cedula = ? AND id <> ?', [nuevaCedula, id]);
      if (existeCedula.length) {
        throw cedulaOcupada(existeCedula[0], nuevaCedula, 'otro usuario registrado');
      }
    }

    if (nuevoEstado === 'INACTIVO' && estadoActual === 'ACTIVO') {
      if (id === req.user.personaId) {
        throw forbidden('No puede desactivar su propio registro de persona.');
      }
      const cuenta = await cuentaDePersona(conexion, id, { bloquear: true });
      if (cuenta) await exigirPermisoSobreTesorero(conexion, req.user, { cuenta });
      if (cuenta && ROLES_DIRECTIVA.includes(cuenta.rol) && cuenta.estado === 'ACTIVA') {
        await exigirOtroAdministrador(conexion, id, 'No se puede desactivar a la persona porque es el último administrador activo.');
      }
    }

    await conexion.query(
      `UPDATE personas
       SET cedula = ?, nombres = ?, apellidos = ?, direccion = ?, telefono = ?, celular = ?, email = ?, fecha_nacimiento = ?, estado = ?
       WHERE id = ?`,
      [nuevaCedula, datos.nombres, datos.apellidos, datos.direccion, datos.telefono, datos.celular, datos.email, datos.fecha_nacimiento, nuevoEstado, id]
    );
    await registrarAuditoria({
      conexion, cuentaId: req.user.cuentaId, accion: 'MODIFICAR', entidad: 'personas', entidadId: id, ip: req.ip,
      detalle: {
        nombres: datos.nombres,
        apellidos: datos.apellidos,
        estado: nuevoEstado,
        ...(nuevaCedula !== personaActual.cedula ? { cedulaAnterior: personaActual.cedula, cedulaNueva: nuevaCedula } : {})
      }
    });
  });

  return res.json({ status: 'OK', message: 'Datos del usuario actualizados correctamente.' });
}

/**
 * Eliminar un usuario. Sin historial (0 lotes, obligaciones, pagos, asistencias ni sectores representados) se borra
 * de verdad junto con su cuenta. Con historial no se borra: se oculta del padrón (queda inactivo y marcado con
 * `oculta_en`) y se puede restaurar. Para ocultarlo no debe tener lotes, sectores a su cargo ni deudas pendientes:
 * hay que transferirlos o cobrarlos antes, así ningún lote queda con un titular invisible.
 */
async function deletePersona(req, res) {
  const { id } = s.idParam.parse(req.params);
  if (id === req.user.personaId) {
    throw forbidden('No puede eliminar su propio registro.');
  }

  const resultado = await withTransaction(async (conexion) => {
    const [personaRows] = await conexion.query('SELECT id, cedula, nombres, apellidos, oculta_en FROM personas WHERE id = ? FOR UPDATE', [id]);
    if (!personaRows.length) throw notFound('Usuario no encontrado.');
    const persona = personaRows[0];
    if (persona.oculta_en) throw conflict('El usuario ya está eliminado (oculto).');
    const cuenta = await cuentaDePersona(conexion, id, { bloquear: true });
    if (cuenta) await exigirPermisoSobreTesorero(conexion, req.user, { cuenta });

    const contar = async (sql) => Number((await conexion.query(sql, [id]))[0][0].n);
    const lotes = await contar('SELECT COUNT(*) AS n FROM persona_lotes WHERE persona_id = ?');
    const obligaciones = await contar('SELECT COUNT(*) AS n FROM obligaciones WHERE persona_id = ?');
    const obligacionesAgua = await contar('SELECT COUNT(*) AS n FROM obligacion_anual_agua WHERE persona_id = ?');
    const asistencias = await contar('SELECT COUNT(*) AS n FROM asistencias WHERE persona_id = ?');
    const sectores = await contar('SELECT COUNT(*) AS n FROM sectores WHERE representante_persona_id = ?');
    const pagos = await contar('SELECT COUNT(*) AS n FROM pagos WHERE persona_id = ?');
    const sinHistorial = lotes + obligaciones + obligacionesAgua + asistencias + sectores + pagos === 0;

    if (sinHistorial) {
      await conexion.query('DELETE FROM cuentas WHERE persona_id = ?', [id]);
      await conexion.query('DELETE FROM personas WHERE id = ?', [id]);
      await registrarAuditoria({
        conexion, cuentaId: req.user.cuentaId, accion: 'ELIMINAR', entidad: 'personas', entidadId: id, ip: req.ip,
        detalle: { cedula: persona.cedula, nombres: `${persona.nombres} ${persona.apellidos}` }
      });
      return { accion: 'ELIMINADO', message: 'Usuario eliminado exitosamente del padrón.' };
    }

    const pendientes = (await contar("SELECT COUNT(*) AS n FROM obligaciones WHERE persona_id = ? AND estado = 'PENDIENTE'"))
      + (await contar("SELECT COUNT(*) AS n FROM obligacion_anual_agua WHERE persona_id = ? AND estado = 'PENDIENTE'"));
    const impedimentos = [];
    if (lotes) impedimentos.push(`${lotes} lote(s) asignado(s): transfiéralos a otra persona`);
    if (sectores) impedimentos.push(`${sectores} sector(es) que representa: designe otro representante`);
    if (pendientes) impedimentos.push(`${pendientes} deuda(s) pendiente(s): cóbrelas o anúlelas`);
    if (impedimentos.length) {
      throw conflict(`No se puede eliminar a ${persona.nombres} ${persona.apellidos} todavía. Antes: ${impedimentos.join('; ')}.`);
    }

    if (cuenta && ROLES_DIRECTIVA.includes(cuenta.rol) && cuenta.estado === 'ACTIVA') {
      await exigirOtroAdministrador(conexion, id, 'No se puede eliminar a la persona porque es el último administrador activo.');
    }
    await conexion.query(
      "UPDATE personas SET estado = 'INACTIVO', oculta_en = NOW(), oculta_por_cuenta_id = ? WHERE id = ?",
      [req.user.cuentaId, id]
    );
    await registrarAuditoria({
      conexion, cuentaId: req.user.cuentaId, accion: 'OCULTAR', entidad: 'personas', entidadId: id, ip: req.ip,
      detalle: { cedula: persona.cedula, nombres: `${persona.nombres} ${persona.apellidos}` }
    });
    return {
      accion: 'OCULTADO',
      message: 'El usuario tiene historial, por eso no se borró: quedó oculto del padrón. Puede restaurarlo desde "Ver eliminados".'
    };
  });

  return res.json({ status: 'OK', ...resultado });
}

/** Devuelve al padrón a un usuario oculto: queda activo otra vez, con su historial intacto. */
async function restaurarPersona(req, res) {
  const { id } = s.idParam.parse(req.params);
  await withTransaction(async (conexion) => {
    const [personaRows] = await conexion.query('SELECT id, cedula, nombres, apellidos, oculta_en FROM personas WHERE id = ? FOR UPDATE', [id]);
    if (!personaRows.length) throw notFound('Usuario no encontrado.');
    const persona = personaRows[0];
    if (!persona.oculta_en) throw conflict('El usuario no está eliminado.');
    const cuenta = await cuentaDePersona(conexion, id, { bloquear: true });
    if (cuenta) await exigirPermisoSobreTesorero(conexion, req.user, { cuenta });
    await conexion.query("UPDATE personas SET estado = 'ACTIVO', oculta_en = NULL, oculta_por_cuenta_id = NULL WHERE id = ?", [id]);
    await registrarAuditoria({
      conexion, cuentaId: req.user.cuentaId, accion: 'RESTAURAR', entidad: 'personas', entidadId: id, ip: req.ip,
      detalle: { cedula: persona.cedula, nombres: `${persona.nombres} ${persona.apellidos}` }
    });
  });
  return res.json({ status: 'OK', message: 'Usuario restaurado en el padrón.' });
}

/** Crear la cuenta de acceso de un usuario que aún no la tiene. */
async function crearCuenta(req, res) {
  const { id } = s.idParam.parse(req.params);
  const { rol } = cuentaCrearSchema.parse(req.body ?? {});

  const passwordTemporal = await withTransaction(async (conexion) => {
    const [persona] = await conexion.query('SELECT id FROM personas WHERE id = ? FOR UPDATE', [id]);
    if (!persona.length) throw notFound('Usuario no encontrado.');
    if (await cuentaDePersona(conexion, id)) throw conflict('El usuario ya tiene una cuenta de acceso.');
    await exigirPermisoSobreTesorero(conexion, req.user, { rolNuevo: rol });
    const clave = await crearCuentaEnTransaccion(conexion, { personaId: id, rol, creadaPor: req.user.cuentaId });
    await registrarAuditoria({ conexion, cuentaId: req.user.cuentaId, accion: 'CREAR', entidad: 'cuentas', entidadId: id, ip: req.ip, detalle: { personaId: id, rol } });
    return clave;
  });
  return res.status(201).json({ status: 'OK', message: 'Cuenta creada. Entregue la contraseña temporal al usuario.', passwordTemporal });
}

/** Cambiar rol o estado de una cuenta. */
async function actualizarCuenta(req, res) {
  const { id } = s.idParam.parse(req.params);
  const cambios = cuentaActualizarSchema.parse(req.body);
  if (id === req.user.personaId) throw forbidden('No puede modificar el rol ni el estado de su propia cuenta.');

  await withTransaction(async (conexion) => {
    const cuenta = await cuentaDePersona(conexion, id, { bloquear: true });
    if (!cuenta) throw notFound('El usuario no tiene cuenta de acceso.');

    await exigirPermisoSobreTesorero(conexion, req.user, { cuenta, rolNuevo: cambios.rol });
    const dejaDeSerAdmin = ROLES_DIRECTIVA.includes(cuenta.rol) && cuenta.estado === 'ACTIVA' &&
      ((cambios.rol && !ROLES_DIRECTIVA.includes(cambios.rol)) || (cambios.estado && cambios.estado !== 'ACTIVA'));
    if (dejaDeSerAdmin) await exigirOtroAdministrador(conexion, id, 'Debe existir al menos un administrador activo.');

    if (cambios.rol) await conexion.query('UPDATE cuentas SET rol_id = ? WHERE id = ?', [await idRol(conexion, cambios.rol), cuenta.id]);
    if (cambios.estado) {
      await conexion.query('UPDATE cuentas SET estado = ? WHERE id = ?', [cambios.estado, cuenta.id]);
      await conexion.query('DELETE FROM intentos_login WHERE cuenta_id = ?', [cuenta.id]);
    }
    await registrarAuditoria({ conexion, cuentaId: req.user.cuentaId, accion: 'MODIFICAR', entidad: 'cuentas', entidadId: id, ip: req.ip, detalle: cambios });
  });
  return res.json({ status: 'OK', message: 'Cuenta actualizada correctamente.' });
}

/**
 * Restablecer la contraseña: genera una temporal, obliga a cambiarla e invalida las sesiones abiertas.
 */
async function restablecerPassword(req, res) {
  const { id } = s.idParam.parse(req.params);
  if (id === req.user.personaId) {
    throw forbidden('No puede restablecer su propia contraseña; use la opción de cambio de contraseña.');
  }

  const passwordTemporal = await withTransaction(async (conexion) => {
    const cuenta = await cuentaDePersona(conexion, id, { bloquear: true });
    if (!cuenta) throw notFound('El usuario no tiene cuenta de acceso.');
    await exigirPermisoSobreTesorero(conexion, req.user, { cuenta });
    const clave = generarPasswordTemporal();
    await conexion.query(
      `UPDATE cuentas SET password_hash = ?, debe_cambiar_password = TRUE, password_updated_at = ?
       WHERE id = ?`,
      [await hashPassword(clave), new Date(), cuenta.id]
    );
    await conexion.query('DELETE FROM intentos_login WHERE cuenta_id = ?', [cuenta.id]);
    await registrarAuditoria({ conexion, cuentaId: req.user.cuentaId, accion: 'MODIFICAR', entidad: 'cuentas', entidadId: id, ip: req.ip, detalle: { restablecerPassword: true } });
    return clave;
  });
  return res.json({ status: 'OK', message: 'Contraseña restablecida. Entregue la contraseña temporal al usuario.', passwordTemporal });
}

/**
 * Cuentas con el inicio de sesión bloqueado ahora mismo (tras varios intentos fallidos), para que la directiva
 * las vea y las desbloquee sin esperar. Un bloqueo es por IP: `redes` cuenta desde cuántas está bloqueada.
 */
async function getCuentasBloqueadas(req, res) {
  const [filas] = await db.query(
    `SELECT p.id AS persona_id, p.cedula, p.nombres, p.apellidos, COUNT(*) AS redes,
            GREATEST(1, CEIL(TIMESTAMPDIFF(SECOND, UTC_TIMESTAMP(), MAX(il.bloqueado_hasta)) / 60)) AS minutos_restantes
     FROM intentos_login il
     JOIN cuentas c ON c.id = il.cuenta_id
     JOIN personas p ON p.id = c.persona_id
     WHERE il.bloqueado_hasta > UTC_TIMESTAMP()
     GROUP BY p.id, p.cedula, p.nombres, p.apellidos
     ORDER BY MAX(il.bloqueado_hasta) DESC`
  );
  return res.json({ status: 'OK', data: filas.map((f) => ({ ...f, redes: Number(f.redes), minutos_restantes: Number(f.minutos_restantes) })) });
}

/** Levanta el bloqueo de inicio de sesión de una cuenta (desde todas las IP) sin cambiar su contraseña. */
async function desbloquearCuenta(req, res) {
  const { id } = s.idParam.parse(req.params);
  await withTransaction(async (conexion) => {
    const cuenta = await cuentaDePersona(conexion, id, { bloquear: true });
    if (!cuenta) throw notFound('El usuario no tiene cuenta de acceso.');
    await conexion.query('DELETE FROM intentos_login WHERE cuenta_id = ?', [cuenta.id]);
    await registrarAuditoria({ conexion, cuentaId: req.user.cuentaId, accion: 'MODIFICAR', entidad: 'cuentas', entidadId: id, ip: req.ip, detalle: { desbloqueo: true } });
  });
  return res.json({ status: 'OK', message: 'Cuenta desbloqueada. El usuario ya puede iniciar sesión.' });
}

module.exports = {
  getPersonas,
  getPersonaById,
  consultaPublicaPorCedula,
  createPersona,
  updatePersona,
  deletePersona,
  restaurarPersona,
  crearCuenta,
  actualizarCuenta,
  restablecerPassword, getCuentasBloqueadas, desbloquearCuenta
};
