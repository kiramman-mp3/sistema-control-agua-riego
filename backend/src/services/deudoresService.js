/**
 * Deudores del agua y de las multas (asambleas y mingas): un resumen corto y el detalle por usuario.
 *
 * El año en curso se muestra desglosado (el agua por lote; las multas mes a mes). Lo que quedó impago de años
 * anteriores se junta en un solo valor por concepto, sea porque se digitó como acumulado desde el papel o porque
 * es una deuda de un año que ya terminó: el 1 de enero el sistema las suma sin tocar los registros.
 * El agua pendiente incluye el recargo del 10% si ya pasó el 31 de marzo del año de la cuota.
 */
const { hoy } = require('../shared/dates');
const { aCentavos, aDolares } = require('../shared/money');
const { recargoAgua } = require('./finanzasService');

const CODIGOS_MULTA = {
  ASAMBLEA: ['MULTA_ASAMBLEA', 'MULTA_ASAMBLEA_ANTERIOR'],
  MINGA: ['MULTA_MINGA', 'MULTA_MINGA_ANTERIOR']
};
const TIPO_DE_CODIGO = Object.fromEntries(
  Object.entries(CODIGOS_MULTA).flatMap(([tipo, codigos]) => codigos.map((c) => [c, tipo]))
);
const CODIGO_AGUA_ANTERIOR = 'AGUA_ANTERIOR';

const vacioAgua = () => ({ actual: 0, recargo_actual: 0, anteriores: 0, recargo_anteriores: 0, lotes_actual: [] });
const vacioMulta = () => ({ actual: 0, anteriores: 0, meses: new Map() });

/** Importes en centavos mientras se acumulan; se convierten a dólares al final. */
function nuevoDeudor(fila) {
  return {
    persona_id: fila.persona_id, cedula: fila.cedula, nombre: fila.nombre,
    agua: vacioAgua(), ASAMBLEA: vacioMulta(), MINGA: vacioMulta()
  };
}

const dolares = (centavos) => aDolares(centavos);

function formatearMulta(m) {
  return {
    actual: dolares(m.actual),
    anteriores: dolares(m.anteriores),
    meses: [...m.meses.entries()].sort((a, b) => a[0] - b[0]).map(([mes, c]) => ({ mes, valor: dolares(c.valor), cantidad: c.cantidad }))
  };
}

/**
 * @param {object} conexion pool o conexión
 * @param {{ fecha?: string }} [opciones] día de referencia ('YYYY-MM-DD'); por defecto hoy en Ecuador
 */
async function deudores(conexion, { fecha = hoy() } = {}) {
  const anioActual = Number(fecha.slice(0, 4));
  const porPersona = new Map();
  const deDe = (fila) => {
    if (!porPersona.has(fila.persona_id)) porPersona.set(fila.persona_id, nuevoDeudor(fila));
    return porPersona.get(fila.persona_id);
  };

  const [cuotas] = await conexion.query(
    `SELECT o.persona_id, o.periodo_anio, o.valor_total, l.codigo AS lote_codigo,
            p.cedula, CONCAT(p.nombres, ' ', p.apellidos) AS nombre
     FROM obligacion_anual_agua o
     JOIN personas p ON p.id = o.persona_id
     LEFT JOIN lotes l ON l.id = o.lote_id
     WHERE o.estado = 'PENDIENTE'`
  );
  for (const c of cuotas) {
    const d = deDe(c);
    const base = aCentavos(c.valor_total);
    const recargo = aCentavos(recargoAgua(c.periodo_anio, c.valor_total, fecha));
    if (c.periodo_anio >= anioActual) {
      d.agua.actual += base;
      d.agua.recargo_actual += recargo;
      if (c.lote_codigo) d.agua.lotes_actual.push(c.lote_codigo);
    } else {
      d.agua.anteriores += base;
      d.agua.recargo_anteriores += recargo;
    }
  }

  const [obligaciones] = await conexion.query(
    `SELECT o.persona_id, o.valor, c.codigo,
            COALESCE(o.periodo_anio, YEAR(COALESCE(e.fecha, o.fecha_emision))) AS anio,
            COALESCE(o.periodo_mes, MONTH(COALESCE(e.fecha, o.fecha_emision))) AS mes,
            p.cedula, CONCAT(p.nombres, ' ', p.apellidos) AS nombre
     FROM obligaciones o
     JOIN conceptos_cobro c ON c.id = o.concepto_id
     JOIN personas p ON p.id = o.persona_id
     LEFT JOIN eventos e ON e.id = o.evento_id
     WHERE o.estado = 'PENDIENTE' AND c.codigo IN (?)`,
    [[CODIGO_AGUA_ANTERIOR, ...Object.values(CODIGOS_MULTA).flat()]]
  );
  for (const o of obligaciones) {
    const d = deDe(o);
    const valor = aCentavos(o.valor);
    if (o.codigo === CODIGO_AGUA_ANTERIOR) { d.agua.anteriores += valor; continue; }
    const multa = d[TIPO_DE_CODIGO[o.codigo]];
    // El acumulado digitado (concepto *_ANTERIOR) y todo lo de un año que ya terminó van a "anteriores".
    if (o.codigo.endsWith('_ANTERIOR') || o.anio < anioActual) { multa.anteriores += valor; continue; }
    multa.actual += valor;
    const mes = multa.meses.get(o.mes) ?? { valor: 0, cantidad: 0 };
    mes.valor += valor;
    mes.cantidad += 1;
    multa.meses.set(o.mes, mes);
  }

  const lista = [...porPersona.values()].map((d) => {
    const aguaTotal = d.agua.actual + d.agua.recargo_actual + d.agua.anteriores + d.agua.recargo_anteriores;
    const multasTotal = d.ASAMBLEA.actual + d.ASAMBLEA.anteriores + d.MINGA.actual + d.MINGA.anteriores;
    return {
      persona_id: d.persona_id,
      cedula: d.cedula,
      nombre: d.nombre,
      agua: {
        actual: dolares(d.agua.actual),
        recargo_actual: dolares(d.agua.recargo_actual),
        anteriores: dolares(d.agua.anteriores + d.agua.recargo_anteriores),
        recargo_anteriores: dolares(d.agua.recargo_anteriores),
        lotes_actual: [...new Set(d.agua.lotes_actual)].sort(),
        total: dolares(aguaTotal)
      },
      multas_asamblea: formatearMulta(d.ASAMBLEA),
      multas_minga: formatearMulta(d.MINGA),
      total_multas: dolares(multasTotal),
      total: dolares(aguaTotal + multasTotal),
      _centavos: aguaTotal + multasTotal
    };
  }).filter((d) => d._centavos > 0)
    .sort((a, b) => b._centavos - a._centavos || a.nombre.localeCompare(b.nombre, 'es'))
    .map(({ _centavos, ...d }) => d);

  const suma = (campo) => dolares(lista.reduce((s, d) => s + aCentavos(campo(d)), 0));
  return {
    fecha,
    anio: anioActual,
    resumen: {
      usuarios: lista.length,
      total: suma((d) => d.total),
      agua: {
        total: suma((d) => d.agua.total),
        actual: suma((d) => d.agua.actual),
        recargo_actual: suma((d) => d.agua.recargo_actual),
        anteriores: suma((d) => d.agua.anteriores),
        usuarios: lista.filter((d) => d.agua.total > 0).length
      },
      multas_asamblea: {
        total: suma((d) => d.multas_asamblea.actual + d.multas_asamblea.anteriores),
        actual: suma((d) => d.multas_asamblea.actual),
        anteriores: suma((d) => d.multas_asamblea.anteriores),
        usuarios: lista.filter((d) => d.multas_asamblea.actual + d.multas_asamblea.anteriores > 0).length
      },
      multas_minga: {
        total: suma((d) => d.multas_minga.actual + d.multas_minga.anteriores),
        actual: suma((d) => d.multas_minga.actual),
        anteriores: suma((d) => d.multas_minga.anteriores),
        usuarios: lista.filter((d) => d.multas_minga.actual + d.multas_minga.anteriores > 0).length
      }
    },
    deudores: lista
  };
}

module.exports = { deudores };
