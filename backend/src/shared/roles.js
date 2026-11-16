/**
 * El sistema tiene tres roles:
 * - ADMIN: la directiva de la Junta; gestiona el sistema, sin acceso a la parte financiera.
 * - TESORERO: la directiva con todas las funciones de ADMIN y, en exclusiva, la parte financiera.
 * - USUARIO: consulta únicamente su propia información.
 */
const ROLES = Object.freeze({
  ADMIN: 'ADMIN',
  TESORERO: 'TESORERO',
  USUARIO: 'USUARIO'
});

/** Roles de la directiva: pueden gestionar el sistema (todo menos las finanzas, que son del tesorero). */
const ROLES_DIRECTIVA = Object.freeze([ROLES.ADMIN, ROLES.TESORERO]);

const esAdmin = (user) => Boolean(user) && ROLES_DIRECTIVA.includes(user.rol);
const esTesorero = (user) => Boolean(user) && user.rol === ROLES.TESORERO;

/**
 * Devuelve el persona_id que un usuario puede consultar:
 * la directiva puede ver a cualquiera (o a quien pida); un usuario solo a sí mismo.
 */
function personaPermitida(user, personaSolicitada) {
  if (esAdmin(user)) return personaSolicitada ?? null;
  return user.personaId;
}

/**
 * Igual que personaPermitida pero para datos financieros (deudas, pagos): solo el tesorero ve los de cualquiera;
 * los demás, incluida el resto de la directiva, solo los propios.
 */
function personaFinancieraPermitida(user, personaSolicitada) {
  if (esTesorero(user)) return personaSolicitada ?? null;
  return user.personaId;
}

module.exports = { ROLES, ROLES_DIRECTIVA, esAdmin, esTesorero, personaPermitida, personaFinancieraPermitida };
