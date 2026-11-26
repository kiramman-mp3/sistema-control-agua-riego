/**
 * Carga de históricos: lo que la Junta llevaba en papel antes del sistema.
 *
 * - Agua del año en curso: por cada lote del usuario se indica si debe o si ya pagó en papel. Si debe, queda la
 *   cuota PENDIENTE calculada por hectárea; si ya pagó, queda PAGADA con la marca `pagada_antes_sistema`, sin recibo
 *   y sin sumar al balance de ingresos (ese dinero no pasó por el sistema).
 * - Años anteriores: un solo valor acumulado por concepto (agua, multas de asambleas y multas de mingas).
 * - Multas del año en curso: un valor por mes y por tipo.
 * - Caja previa: el total que la Junta ya tenía en caja, anotado aparte de los pagos.
 *
 * Todo se guarda en las mismas tablas de cobro, así Cobrar, Mi cuenta, el balance y los deudores no necesitan
 * un camino aparte. Es idempotente: guardar de nuevo corrige los valores pendientes; lo ya cobrado no se toca.
 */
const { badRequest, notFound, conflict } = require('../shared/errors');
const { hoy } = require('../shared/dates');
const finanzas = require('./finanzasService');

const OBSERVACION_HISTORICO = 'Histórico (registro en papel)';
const MOTIVO_CORRECCION = 'Corregido en el registro histórico';

/** Conceptos del acumulado de años anteriores y de las multas mensuales del año en curso, por tipo de multa. */
const CONCEPTOS = Object.freeze({
  AGUA_ANTERIOR: 'AGUA_ANTERIOR',
  ASAMBLEA: { anterior: 'MULTA_ASAMBLEA_ANTERIOR', mensual: 'MULTA_ASAMBLEA' },
  MINGA: { anterior: 'MULTA_MINGA_ANTERIOR', mensual: 'MULTA_MINGA' }
});

const anioActual = () => Number(hoy().slice(0, 4));
const mesActual = () => Number(hoy().slice(5, 7));
const dosDigitos = (n) => String(n).padStart(2, '0');

async function personaActiva(conexion, personaId, { bloquear = false } = {}) {
  const [filas] = await conexion.query(
    `SELECT id, cedula, CONCAT(nombres, ' ', apellidos) AS nombre, estado FROM personas WHERE id = ?${bloquear ? ' FOR UPDATE' : ''}`,
    [personaId]
  );
  if (!filas.length) throw notFound('El usuario no existe.');
  if (filas[0].estado !== 'ACTIVO') throw conflict('El usuario está inactivo: restáurelo o actívelo antes de registrar su histórico.');
  return filas[0];
}

/** Lotes activos del usuario con su cuota del año (si existe). */
async function lotesDelUsuario(conexion, personaId, anio) {
  const [filas] = await conexion.query(
    `SELECT l.id AS lote_id, l.codigo, l.superficie_m2, s.nombre AS sector_nombre,
            o.id AS cuota_id, o.estado AS cuota_estado, o.valor_total AS cuota_valor, o.pagada_antes_sistema
     FROM persona_lotes pl
     JOIN lotes l ON l.id = pl.lote_id AND l.activo = TRUE
     LEFT JOIN sectores s ON s.id = l.sector_id
     LEFT JOIN obligacion_anual_agua o ON o.lote_id = l.id AND o.periodo_anio = ?
     WHERE pl.persona_id = ?
     ORDER BY l.codigo`,
    [anio, personaId]
  );
  return filas;
}

/** Valor por hectárea sugerido: la tarifa vigente al 1 de enero del año o, si no había, la vigente hoy. */
async function valorHectareaSugerido(conexion, anio) {
  const concepto = await finanzas.conceptoPorCodigo(conexion, 'AGUA_ANUAL');
  const tarifa = (await finanzas.tarifaVigente(conexion, concepto.id, `${anio}-01-01`))
    ?? (await finanzas.tarifaVigente(conexion, concepto.id, hoy()));
  return tarifa ? Number(tarifa.valor) : null;
}

/** Estado actual del histórico de un usuario, para llenar el formulario. */
async function consultarHistorico(conexion, personaId, anio = anioActual()) {
  const persona = await personaActiva(conexion, personaId);
  const lotes = await lotesDelUsuario(conexion, personaId, anio);

  const codigos = [CONCEPTOS.AGUA_ANTERIOR, CONCEPTOS.ASAMBLEA.anterior, CONCEPTOS.ASAMBLEA.mensual, CONCEPTOS.MINGA.anterior, CONCEPTOS.MINGA.mensual];
  const [filas] = await conexion.query(
    `SELECT o.id, o.valor, o.estado, o.periodo_anio, o.periodo_mes, o.evento_id, c.codigo
     FROM obligaciones o JOIN conceptos_cobro c ON c.id = o.concepto_id
     WHERE o.persona_id = ? AND o.estado <> 'ANULADA' AND c.codigo IN (?)`,
    [personaId, codigos]
  );
  const monto = (f) => ({ id: f.id, valor: Number(f.valor), estado: f.estado });
  const anterior = (codigo) => {
    const fila = filas.find((f) => f.codigo === codigo);
    return fila ? monto(fila) : null;
  };
  const meses = (codigo) => Object.fromEntries(
    filas.filter((f) => f.codigo === codigo && f.evento_id === null && f.periodo_anio === anio && f.periodo_mes)
      .map((f) => [String(f.periodo_mes), monto(f)])
  );

  return {
    persona: { id: persona.id, cedula: persona.cedula, nombre: persona.nombre },
    anio,
    mes_actual: anio === anioActual() ? mesActual() : 12,
    valor_hectarea_sugerido: await valorHectareaSugerido(conexion, anio),
    lotes: lotes.map((l) => ({
      lote_id: l.lote_id,
      codigo: l.codigo,
      sector_nombre: l.sector_nombre,
      superficie_m2: l.superficie_m2 === null ? null : Number(l.superficie_m2),
      hectareas: finanzas.hectareasDeLote(l.superficie_m2),
      cuota: l.cuota_id
        ? { id: l.cuota_id, estado: l.cuota_estado, valor_total: Number(l.cuota_valor), pagada_antes_sistema: Boolean(l.pagada_antes_sistema) }
        : null
    })),
    agua_anterior: anterior(CONCEPTOS.AGUA_ANTERIOR),
    multas: {
      ASAMBLEA: { anterior: anterior(CONCEPTOS.ASAMBLEA.anterior), meses: meses(CONCEPTOS.ASAMBLEA.mensual) },
      MINGA: { anterior: anterior(CONCEPTOS.MINGA.anterior), meses: meses(CONCEPTOS.MINGA.mensual) }
    }
  };
}

/**
 * Fija el valor pendiente de una obligación histórica (una por usuario, concepto y período).
 * `valor` undefined no la toca; 0 anula la pendiente; un valor la crea o la corrige. Una ya cobrada no se modifica.
 * @returns {'creada'|'actualizada'|'anulada'|null}
 */
async function fijarMonto(conexion, { personaId, codigo, anio, mes, valor, emision }) {
  if (valor === undefined || valor === null) return null;
  const concepto = await finanzas.conceptoPorCodigo(conexion, codigo);
  const [existentes] = await conexion.query(
    `SELECT id, valor, estado FROM obligaciones
     WHERE persona_id = ? AND concepto_id = ? AND periodo_anio <=> ? AND periodo_mes <=> ? AND evento_id IS NULL
     ORDER BY id DESC LIMIT 1 FOR UPDATE`,
    [personaId, concepto.id, anio, mes]
  );
  const actual = existentes[0];

  if (!(valor > 0)) {
    if (actual?.estado === 'PENDIENTE') {
      await conexion.query(
        "UPDATE obligaciones SET estado = 'ANULADA', fecha_anulacion = UTC_TIMESTAMP(), motivo_anulacion = ? WHERE id = ?",
        [MOTIVO_CORRECCION, actual.id]
      );
      return 'anulada';
    }
    return null;
  }

  if (actual?.estado === 'PAGADA') {
    if (Number(actual.valor) === valor) return null;
    throw conflict(`El valor de ${concepto.nombre}${mes ? ` (mes ${mes})` : ''} ya fue cobrado en caja y no se puede modificar aquí. Anule antes el pago.`);
  }
  if (actual) {
    await conexion.query(
      `UPDATE obligaciones SET valor = ?, estado = 'PENDIENTE', fecha_anulacion = NULL, motivo_anulacion = NULL, anulada_por_cuenta_id = NULL WHERE id = ?`,
      [valor, actual.id]
    );
    return Number(actual.valor) === valor && actual.estado === 'PENDIENTE' ? null : 'actualizada';
  }
  await conexion.query(
    `INSERT INTO obligaciones (persona_id, concepto_id, periodo_anio, periodo_mes, fecha_emision, fecha_vencimiento, valor, origen, estado, observacion)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'MANUAL', 'PENDIENTE', ?)`,
    [personaId, concepto.id, anio, mes, emision, finanzas.vencimientoPorDefecto(emision), valor, OBSERVACION_HISTORICO]
  );
  return 'creada';
}

/** Marca la cuota del agua de un lote del año como debida o pagada en papel; crea la cuota si no existe. */
async function fijarCuotaDeLote(conexion, { personaId, lote, anio, valorHectarea, estado }) {
  const [[existente]] = await conexion.query(
    'SELECT id, estado, pagada_antes_sistema FROM obligacion_anual_agua WHERE lote_id = ? AND periodo_anio = ? FOR UPDATE',
    [lote.id, anio]
  );
  const pagadaEnPapel = estado === 'PAGADA';

  if (!existente) {
    await conexion.query(
      `INSERT INTO obligacion_anual_agua (persona_id, lote_id, periodo_anio, valor_total, valor_hectarea, superficie_m2, estado, pagada_antes_sistema, fecha_emision, fecha_vencimiento)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [personaId, lote.id, anio, finanzas.cuotaAnualDeLote(lote.superficie_m2, valorHectarea), valorHectarea, lote.superficie_m2,
        pagadaEnPapel ? 'PAGADA' : 'PENDIENTE', pagadaEnPapel, `${anio}-01-01`, finanzas.limiteSinRecargo(anio)]
    );
    return 'creada';
  }
  if (existente.estado === 'ANULADA') throw conflict(`La cuota ${anio} del lote ${lote.codigo} está anulada.`);

  if (pagadaEnPapel) {
    if (existente.estado === 'PENDIENTE') {
      await conexion.query("UPDATE obligacion_anual_agua SET estado = 'PAGADA', pagada_antes_sistema = TRUE WHERE id = ?", [existente.id]);
      return 'actualizada';
    }
    return null;
  }
  if (existente.estado === 'PAGADA') {
    if (!existente.pagada_antes_sistema) {
      throw conflict(`La cuota ${anio} del lote ${lote.codigo} ya se cobró con un recibo. Anule el pago en Historial financiero si debe volver a quedar pendiente.`);
    }
    await conexion.query("UPDATE obligacion_anual_agua SET estado = 'PENDIENTE', pagada_antes_sistema = FALSE WHERE id = ?", [existente.id]);
    return 'actualizada';
  }
  return null;
}

/**
 * Guarda el histórico de un usuario.
 * @param {object} datos
 * @param {number} datos.personaId
 * @param {number} [datos.anio] año de las multas por mes y de la cuota de agua (por defecto, el actual)
 * @param {number|null} [datos.valorHectarea] valor por hectárea; sin él se usa la tarifa vigente
 * @param {Array<{ lote_id: number, estado: 'DEBE'|'PAGADA' }>} [datos.lotes]
 * @param {number} [datos.aguaAnterior] acumulado de agua de años anteriores
 * @param {{ ASAMBLEA?: { anterior?: number, meses?: Record<string, number> }, MINGA?: { anterior?: number, meses?: Record<string, number> } }} [datos.multas]
 */
async function guardarHistorico(conexion, { personaId, anio = anioActual(), valorHectarea = null, lotes = [], aguaAnterior, multas = {} }) {
  if (anio > anioActual()) throw badRequest('No se puede registrar el histórico de un año futuro.');
  await personaActiva(conexion, personaId, { bloquear: true });
  const cambios = { lotes: 0, montos: 0 };

  if (lotes.length) {
    const ids = [...new Set(lotes.map((l) => Number(l.lote_id)))];
    const propios = (await lotesDelUsuario(conexion, personaId, anio)).filter((l) => ids.includes(Number(l.lote_id)));
    if (propios.length !== ids.length) throw badRequest('Uno o más lotes no pertenecen a este usuario.');
    const sinSuperficie = propios.filter((l) => finanzas.hectareasDeLote(l.superficie_m2) === null);
    if (sinSuperficie.length) {
      throw conflict('Hay lotes sin superficie: complétela en el catastro para calcular el agua.', {
        lotes_sin_superficie: sinSuperficie.map((l) => ({ id: l.lote_id, codigo: l.codigo, sector_nombre: l.sector_nombre }))
      });
    }
    // El valor por hectárea solo hace falta para crear cuotas nuevas; las que ya existen conservan el suyo.
    const valor = propios.some((l) => !l.cuota_id)
      ? await finanzas.valorHectareaAgua(conexion, anio, valorHectarea)
      : valorHectarea;
    for (const pedido of lotes) {
      const lote = propios.find((l) => Number(l.lote_id) === Number(pedido.lote_id));
      const resultado = await fijarCuotaDeLote(conexion, {
        personaId, lote: { id: lote.lote_id, codigo: lote.codigo, superficie_m2: Number(lote.superficie_m2) }, anio, valorHectarea: valor, estado: pedido.estado
      });
      if (resultado) cambios.lotes++;
    }
  }

  const emisionAnterior = hoy();
  const registrar = async (datosMonto) => { if (await fijarMonto(conexion, { personaId, ...datosMonto })) cambios.montos++; };

  await registrar({ codigo: CONCEPTOS.AGUA_ANTERIOR, anio: null, mes: null, valor: aguaAnterior, emision: emisionAnterior });
  for (const tipo of ['ASAMBLEA', 'MINGA']) {
    const datosTipo = multas[tipo] ?? {};
    await registrar({ codigo: CONCEPTOS[tipo].anterior, anio: null, mes: null, valor: datosTipo.anterior, emision: emisionAnterior });
    for (const [mesTexto, valor] of Object.entries(datosTipo.meses ?? {})) {
      const mes = Number(mesTexto);
      if (anio === anioActual() && mes > mesActual()) throw badRequest('No se pueden registrar multas de meses que aún no llegan.');
      await registrar({ codigo: CONCEPTOS[tipo].mensual, anio, mes, valor, emision: `${anio}-${dosDigitos(mes)}-01` });
    }
  }
  return cambios;
}

// ---- Caja previa al sistema ----

/** Ingresos previos al sistema (el total de caja que la Junta ya tenía), del más reciente al más antiguo. */
async function listarIngresosPrevios(conexion) {
  const [filas] = await conexion.query(
    `SELECT i.id, i.fecha, i.valor, i.descripcion, i.estado, i.motivo_anulacion, i.fecha_anulacion,
            CONCAT(reg.nombres, ' ', reg.apellidos) AS registrado_por_usuario
     FROM ingresos_previos i
     LEFT JOIN cuentas c ON c.id = i.registrado_por_cuenta_id
     LEFT JOIN personas reg ON reg.id = c.persona_id
     ORDER BY i.fecha DESC, i.id DESC`
  );
  return filas.map((f) => ({ ...f, valor: Number(f.valor) }));
}

async function registrarIngresoPrevio(conexion, { fecha, valor, descripcion }, cuentaId) {
  const [r] = await conexion.query(
    'INSERT INTO ingresos_previos (fecha, valor, descripcion, registrado_por_cuenta_id) VALUES (?, ?, ?, ?)',
    [fecha, valor, descripcion, cuentaId]
  );
  return r.insertId;
}

async function anularIngresoPrevio(conexion, { id, motivo, cuentaId }) {
  const [filas] = await conexion.query('SELECT * FROM ingresos_previos WHERE id = ? FOR UPDATE', [id]);
  if (!filas.length) throw notFound('Ingreso previo no encontrado.');
  if (filas[0].estado === 'ANULADO') throw conflict('Este registro ya fue anulado.');
  await conexion.query(
    "UPDATE ingresos_previos SET estado = 'ANULADO', motivo_anulacion = ?, fecha_anulacion = UTC_TIMESTAMP(), anulado_por_cuenta_id = ? WHERE id = ?",
    [motivo, cuentaId, id]
  );
  return { ingreso: filas[0] };
}

module.exports = {
  CONCEPTOS, OBSERVACION_HISTORICO, consultarHistorico, guardarHistorico,
  listarIngresosPrevios, registrarIngresoPrevio, anularIngresoPrevio
};
