/**
 * Reglas de los turnos de riego semanales. Reciben una conexión en transacción.
 * El turno es del sector: el agua llega al sector por un mismo canal y un representante la recibe en
 * nombre de todos sus usuarios.
 * Las horas llegan normalizadas a 'HH:MM:SS', así que se comparan como texto sin ambigüedad
 * ('09:00:00' < '10:00:00'; con '9:00' frente a '10:00' la comparación de texto fallaba).
 */
const { badRequest, notFound, conflict } = require('../shared/errors');

const DIAS = ['', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado', 'Domingo'];

const MINUTOS_DIA = 1440;
const MINUTOS_SEMANA = 7 * MINUTOS_DIA;
/** Un turno que cruza la medianoche (fin menor al inicio) dura como máximo esto: evita que un error de digitación cree turnos de casi 24 horas. */
const MAX_MINUTOS_NOCTURNO = 12 * 60;
const MENSAJE_HORARIO = 'La hora de inicio y la de fin no pueden ser iguales; un turno que cruza la medianoche dura como máximo 12 horas.';

const aMinutos = (hora) => {
  const [h, m] = String(hora).split(':');
  return Number(h) * 60 + Number(m);
};

/** Duración en minutos de un turno; si la hora de fin es menor a la de inicio, cruza la medianoche. */
function duracionMinutos(horaInicio, horaFin) {
  const diferencia = aMinutos(horaFin) - aMinutos(horaInicio);
  return diferencia > 0 ? diferencia : diferencia + MINUTOS_DIA;
}

/** Un turno es válido si tiene duración y, de cruzar la medianoche, no supera el máximo. */
function horarioValido(horaInicio, horaFin) {
  if (aMinutos(horaInicio) === aMinutos(horaFin)) return false;
  const cruzaMedianoche = aMinutos(horaFin) < aMinutos(horaInicio);
  return !cruzaMedianoche || duracionMinutos(horaInicio, horaFin) <= MAX_MINUTOS_NOCTURNO;
}

/** Intervalo del turno en minutos desde el lunes 00:00; el turno pertenece al día en que inicia. */
function intervaloSemanal(diaSemana, horaInicio, horaFin) {
  const inicio = (diaSemana - 1) * MINUTOS_DIA + aMinutos(horaInicio);
  return [inicio, inicio + duracionMinutos(horaInicio, horaFin)];
}

/** Dos intervalos se cruzan si se solapan en la semana o al pasar del domingo al lunes. */
function seCruzan([inicioA, finA], [inicioB, finB]) {
  return [-MINUTOS_SEMANA, 0, MINUTOS_SEMANA].some((desfase) => inicioA < finB + desfase && finA > inicioB + desfase);
}

/** El sector debe existir y estar activo. Se bloquea para serializar asignaciones concurrentes sobre el mismo canal. */
async function verificarSector(conexion, sectorId) {
  const [sectores] = await conexion.query('SELECT id FROM sectores WHERE id = ? AND activo = TRUE FOR UPDATE', [sectorId]);
  if (!sectores.length) throw notFound('El sector no existe o está inactivo.');
}

/**
 * Rechaza un turno que se cruce con otro turno activo del mismo sector: el agua llega por un
 * mismo canal, así que no puede haber dos horarios a la vez.
 * Considera los turnos que cruzan la medianoche, que invaden el día siguiente.
 */
async function verificarSolape(conexion, { sectorId, diaSemana, horaInicio, horaFin, excluirId = null }) {
  const [turnosSector] = await conexion.query(
    `SELECT id, dia_semana, hora_inicio, hora_fin FROM turnos_riego
     WHERE sector_id = ? AND estado = 'ACTIVO' AND (? IS NULL OR id <> ?)
     FOR UPDATE`,
    [sectorId, excluirId, excluirId]
  );
  const nuevo = intervaloSemanal(diaSemana, horaInicio, horaFin);
  const t = turnosSector.find((otro) => seCruzan(nuevo, intervaloSemanal(otro.dia_semana, otro.hora_inicio, otro.hora_fin)));
  if (t) {
    throw conflict(`El sector ya tiene un turno el ${DIAS[t.dia_semana]} de ${String(t.hora_inicio).slice(0, 5)} a ${String(t.hora_fin).slice(0, 5)} que se cruza con este horario.`);
  }
}

/** Crea un turno semanal del sector, sin cruces de horario con los demás turnos del sector. */
async function crearTurno(conexion, datos) {
  await verificarSector(conexion, datos.sector_id);
  await verificarSolape(conexion, { sectorId: datos.sector_id, diaSemana: datos.dia_semana, horaInicio: datos.hora_inicio, horaFin: datos.hora_fin });

  const [r] = await conexion.query(
    `INSERT INTO turnos_riego (sector_id, dia_semana, hora_inicio, hora_fin, vigencia_desde, observacion)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [datos.sector_id, datos.dia_semana, datos.hora_inicio, datos.hora_fin, datos.vigencia_desde, datos.observacion]
  );
  return { turnoId: r.insertId };
}

/** Actualiza un turno activo. Los campos que no se envían conservan su valor. */
async function actualizarTurno(conexion, id, cambios) {
  const [filas] = await conexion.query("SELECT * FROM turnos_riego WHERE id = ? AND estado = 'ACTIVO' FOR UPDATE", [id]);
  if (!filas.length) throw notFound('Turno no encontrado.');
  const actual = filas[0];
  const final = {
    sector_id: cambios.sector_id ?? actual.sector_id,
    dia_semana: cambios.dia_semana ?? actual.dia_semana,
    hora_inicio: cambios.hora_inicio ?? String(actual.hora_inicio),
    hora_fin: cambios.hora_fin ?? String(actual.hora_fin),
    observacion: cambios.observacion === undefined ? actual.observacion : cambios.observacion
  };
  if (!horarioValido(final.hora_inicio, final.hora_fin)) throw badRequest(MENSAJE_HORARIO);
  await verificarSector(conexion, final.sector_id);
  await verificarSolape(conexion, { sectorId: final.sector_id, diaSemana: final.dia_semana, horaInicio: final.hora_inicio, horaFin: final.hora_fin, excluirId: id });

  await conexion.query(
    `UPDATE turnos_riego SET sector_id = ?, dia_semana = ?, hora_inicio = ?, hora_fin = ?, observacion = ?
     WHERE id = ?`,
    [final.sector_id, final.dia_semana, final.hora_inicio, final.hora_fin, final.observacion, id]
  );
  return { antes: actual, despues: final };
}

/**
 * Designa (o quita, con null) al representante del sector: la persona que recibe el turno de agua en nombre
 * de todos los usuarios del sector. Debe ser un usuario activo.
 */
async function asignarRepresentante(conexion, sectorId, personaId) {
  const [sectores] = await conexion.query(
    'SELECT id, nombre, representante_persona_id FROM sectores WHERE id = ? AND activo = TRUE FOR UPDATE',
    [sectorId]
  );
  if (!sectores.length) throw notFound('El sector no existe o está inactivo.');
  if (personaId !== null) {
    const [personas] = await conexion.query("SELECT id FROM personas WHERE id = ? AND estado = 'ACTIVO'", [personaId]);
    if (!personas.length) throw notFound('El usuario no existe o está inactivo.');
  }
  await conexion.query('UPDATE sectores SET representante_persona_id = ? WHERE id = ?', [personaId, sectorId]);
  return { sector: sectores[0], anterior: sectores[0].representante_persona_id };
}

/**
 * Turnos activos agrupados por sector y día de la semana.
 * `completo` agrega el representante del sector (nombre y cédula) y la observación de cada turno: solo para la
 * directiva. Sin él, cada turno muestra únicamente su horario, para publicarse sin exponer a nadie.
 * Todos los sectores activos aparecen, incluso los que aún no tienen turnos.
 */
async function cronograma(conexion, { sectorId, diaSemana, completo = false } = {}) {
  const condicionesSector = ['s.activo = TRUE'];
  const paramsSector = [];
  if (sectorId) { condicionesSector.push('s.id = ?'); paramsSector.push(sectorId); }
  const [sectoresFilas] = await conexion.query(
    `SELECT s.id, s.nombre, s.descripcion, s.representante_persona_id,
            CONCAT(p.nombres, ' ', p.apellidos) AS representante_nombre, p.cedula AS representante_cedula,
            (SELECT COUNT(*) FROM lotes l WHERE l.sector_id = s.id AND l.activo = TRUE) AS total_lotes
     FROM sectores s LEFT JOIN personas p ON p.id = s.representante_persona_id
     WHERE ${condicionesSector.join(' AND ')}
     ORDER BY s.nombre ASC`,
    paramsSector
  );

  const sectores = new Map(sectoresFilas.map((fila) => [fila.id, {
    sector_id: fila.id,
    sector_nombre: fila.nombre,
    sector_descripcion: fila.descripcion,
    ...(completo ? {
      representante_persona_id: fila.representante_persona_id,
      representante_nombre: fila.representante_nombre,
      representante_cedula: fila.representante_cedula
    } : {}),
    total_lotes: Number(fila.total_lotes),
    total_turnos: 0,
    minutos: 0,
    dias: DIAS.slice(1).map((nombre, i) => ({ dia_semana: i + 1, dia_nombre: nombre, turnos: [] }))
  }]));

  if (sectores.size) {
    const condiciones = ["estado = 'ACTIVO'", `sector_id IN (${[...sectores.keys()].map(() => '?').join(', ')})`];
    const params = [...sectores.keys()];
    if (diaSemana) { condiciones.push('dia_semana = ?'); params.push(diaSemana); }
    const [filas] = await conexion.query(
      `SELECT id, sector_id, dia_semana, hora_inicio, hora_fin, observacion
       FROM turnos_riego WHERE ${condiciones.join(' AND ')}
       ORDER BY dia_semana ASC, hora_inicio ASC`,
      params
    );
    for (const fila of filas) {
      const sector = sectores.get(fila.sector_id);
      const minutos = duracionMinutos(fila.hora_inicio, fila.hora_fin);
      sector.total_turnos++;
      sector.minutos += minutos;
      const turno = {
        id: fila.id,
        hora_inicio: String(fila.hora_inicio).slice(0, 5),
        hora_fin: String(fila.hora_fin).slice(0, 5),
        duracion_minutos: minutos
      };
      if (completo) turno.observacion = fila.observacion;
      sector.dias[fila.dia_semana - 1]?.turnos.push(turno);
    }
  }

  return [...sectores.values()].map(({ minutos, ...sector }) => ({
    ...sector,
    total_horas: Number((minutos / 60).toFixed(1))
  }));
}

async function desactivarTurno(conexion, id) {
  const [r] = await conexion.query("UPDATE turnos_riego SET estado = 'INACTIVO' WHERE id = ? AND estado = 'ACTIVO'", [id]);
  if (!r.affectedRows) throw notFound('Turno no encontrado.');
}

module.exports = { DIAS, MENSAJE_HORARIO, horarioValido, duracionMinutos, verificarSolape, crearTurno, actualizarTurno, desactivarTurno, asignarRepresentante, cronograma };
