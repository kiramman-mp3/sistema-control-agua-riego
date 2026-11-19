// Usuarios "eliminados" que tienen historial: no se borran, se ocultan del padrón. Siguen existiendo (con su cédula
// y su historial) y se pueden restaurar. `oculta_en` NULL significa visible.
module.exports.up = async (db, { addColumnIfMissing, addIndexIfMissing }) => {
  await addColumnIfMissing(db, 'personas', 'oculta_en', 'DATETIME NULL');
  await addColumnIfMissing(db, 'personas', 'oculta_por_cuenta_id', 'BIGINT NULL');
  await addIndexIfMissing(db, 'personas', 'idx_personas_oculta', '(oculta_en)');
};
