// Rol TESORERO: tiene todas las funciones de la directiva y, en exclusiva, la parte financiera
// (cobros, pagos, tarifas, egresos y balances). El rol ADMIN conserva todo lo demás.
module.exports.up = async (db) => {
  await db.query(`INSERT INTO roles (codigo, nombre, descripcion) VALUES
    ('TESORERO', 'Tesorero', 'Todas las funciones de la directiva y, en exclusiva, la gestión financiera')
    ON DUPLICATE KEY UPDATE nombre = VALUES(nombre), descripcion = VALUES(descripcion)`);
  await db.query("UPDATE roles SET descripcion = 'Directiva: gestiona el sistema, sin acceso a la parte financiera' WHERE codigo = 'ADMIN'");
};
