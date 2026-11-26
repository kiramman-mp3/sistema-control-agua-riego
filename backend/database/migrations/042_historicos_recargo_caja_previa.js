// Carga de históricos (datos que la Junta llevaba en papel), recargo del agua anual y caja previa al sistema.
//
// - Conceptos "de años anteriores" (agua y multas): guardan el acumulado que se digita desde el papel. Van marcados
//   como `historico` para que no aparezcan en Tarifas (no tienen tarifa: su valor se digita).
// - obligacion_anual_agua.pagada_antes_sistema: la cuota del año que el socio pagó en papel. Queda PAGADA sin recibo
//   y sin sumar al balance de ingresos (ese dinero no pasó por el sistema).
// - pago_anual_agua_detalle.recargo: parte del valor pagado que corresponde al 10% por pagar después del 31 de marzo.
// - La cuota anual vence el 31 de marzo (antes el 31 de diciembre).
// - ingresos_previos: total de caja que la Junta ya tenía antes del sistema, separado de los pagos registrados.
module.exports.up = async (db, { addColumnIfMissing, addIndexIfMissing }) => {
  await addColumnIfMissing(db, 'conceptos_cobro', 'historico', 'BOOLEAN NOT NULL DEFAULT FALSE');
  await db.query(`INSERT INTO conceptos_cobro (codigo, nombre, descripcion, historico) VALUES
    ('AGUA_ANTERIOR', 'Agua de años anteriores', 'Acumulado del pago anual de agua de años anteriores, registrado desde el papel', TRUE),
    ('MULTA_ASAMBLEA_ANTERIOR', 'Multas de asambleas de años anteriores', 'Acumulado de multas por asambleas de años anteriores, registrado desde el papel', TRUE),
    ('MULTA_MINGA_ANTERIOR', 'Multas de mingas de años anteriores', 'Acumulado de multas por mingas de años anteriores, registrado desde el papel', TRUE)
    ON DUPLICATE KEY UPDATE nombre = VALUES(nombre), descripcion = VALUES(descripcion), historico = TRUE`);

  await addColumnIfMissing(db, 'obligacion_anual_agua', 'pagada_antes_sistema', 'BOOLEAN NOT NULL DEFAULT FALSE');
  await addColumnIfMissing(db, 'pago_anual_agua_detalle', 'recargo', 'DECIMAL(12, 2) NOT NULL DEFAULT 0');

  await db.query(
    "UPDATE obligacion_anual_agua SET fecha_vencimiento = STR_TO_DATE(CONCAT(periodo_anio, '-03-31'), '%Y-%m-%d')"
  );

  await db.query(`CREATE TABLE IF NOT EXISTS ingresos_previos (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    fecha DATE NOT NULL,
    valor DECIMAL(12, 2) NOT NULL,
    descripcion VARCHAR(255) NOT NULL,
    estado ENUM('VIGENTE', 'ANULADO') NOT NULL DEFAULT 'VIGENTE',
    motivo_anulacion VARCHAR(255) NULL,
    fecha_anulacion DATETIME NULL,
    anulado_por_cuenta_id BIGINT NULL,
    registrado_por_cuenta_id BIGINT NOT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_ingresos_previos_registrado FOREIGN KEY (registrado_por_cuenta_id) REFERENCES cuentas(id),
    CONSTRAINT fk_ingresos_previos_anulado FOREIGN KEY (anulado_por_cuenta_id) REFERENCES cuentas(id) ON DELETE SET NULL
  ) ENGINE=InnoDB COMMENT='Total de caja anterior al sistema (pagos hechos en papel), separado de los pagos registrados'`);
  await addIndexIfMissing(db, 'ingresos_previos', 'idx_ingresos_previos_fecha', '(estado, fecha)');
};
