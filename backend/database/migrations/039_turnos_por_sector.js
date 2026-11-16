// Los turnos de riego pasan a ser del sector, no de cada usuario o lote:
// - sectores.representante_persona_id: quien recibe el turno de agua en nombre del sector.
// - turnos_riego.sector_id: sector del horario (se llena desde el lote de cada turno existente).
// persona_id y lote_id quedan como datos históricos opcionales; el sistema ya no los usa.
module.exports.up = async (db, { addColumnIfMissing, addIndexIfMissing }) => {
  await addColumnIfMissing(db, 'sectores', 'representante_persona_id', 'BIGINT NULL');
  const [fkRepresentante] = await db.query(
    "SELECT 1 FROM information_schema.TABLE_CONSTRAINTS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'sectores' AND CONSTRAINT_NAME = 'fk_sectores_representante'"
  );
  if (!fkRepresentante.length) {
    await db.query(
      'ALTER TABLE sectores ADD CONSTRAINT fk_sectores_representante FOREIGN KEY (representante_persona_id) REFERENCES personas(id) ON DELETE SET NULL'
    );
  }

  await addColumnIfMissing(db, 'turnos_riego', 'sector_id', 'BIGINT NULL');
  await db.query(
    `UPDATE turnos_riego t JOIN lotes l ON l.id = t.lote_id
     SET t.sector_id = l.sector_id WHERE t.sector_id IS NULL`
  );
  // Un turno sin sector no se puede aplicar a nadie: se conserva como historial.
  await db.query("UPDATE turnos_riego SET estado = 'INACTIVO' WHERE sector_id IS NULL AND estado = 'ACTIVO'");
  await db.query('ALTER TABLE turnos_riego MODIFY persona_id BIGINT NULL');

  const [fkSector] = await db.query(
    "SELECT 1 FROM information_schema.TABLE_CONSTRAINTS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'turnos_riego' AND CONSTRAINT_NAME = 'fk_turnos_sector'"
  );
  if (!fkSector.length) {
    await db.query(
      'ALTER TABLE turnos_riego ADD CONSTRAINT fk_turnos_sector FOREIGN KEY (sector_id) REFERENCES sectores(id) ON DELETE CASCADE'
    );
  }
  await addIndexIfMissing(db, 'turnos_riego', 'idx_turnos_sector', '(sector_id, dia_semana)');
};
