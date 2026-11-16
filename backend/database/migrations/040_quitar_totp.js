// Se quita la verificación en dos pasos (TOTP): la Junta decidió no usarla. Se borran los secretos y los códigos
// de recuperación guardados (migración 037), que ya no tienen ningún uso.
module.exports.up = async (db, { dropColumnIfExists }) => {
  for (const columna of ['totp_secreto', 'totp_activo', 'totp_ultimo_paso', 'totp_recuperacion']) {
    await dropColumnIfExists(db, 'cuentas', columna);
  }
};
