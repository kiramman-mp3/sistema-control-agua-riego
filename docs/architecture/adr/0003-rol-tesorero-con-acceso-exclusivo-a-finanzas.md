# ADR 0003 — Rol `TESORERO` con acceso exclusivo a las finanzas

- **Estado:** aceptado.
- **Fecha:** 2026-11-16.
- **Origen:** pedido de la comunidad: los valores de cobros y pagos los ve y maneja solo el tesorero; tiene todas las funciones de administrador, pero los demás administradores no entran a la parte financiera.

## Contexto

Hasta ahora cualquier cuenta `ADMIN` podía cobrar, anular pagos, fijar tarifas, registrar egresos y ver el balance. La directiva quiere que el dinero de la Junta lo maneje solo una persona.

## Decisión

- Nuevo rol `TESORERO` (migración `038_rol_tesorero`). Tiene **todas** las funciones de la directiva (`esAdmin` es verdadero para `ADMIN` y `TESORERO`) y, además, es el único con acceso financiero.
- Las rutas de `/api/financiero` (cobros, pagos, pago anual de agua, tarifas, egresos, balance, historial, multas) pasan de `soloAdmin` a `soloTesorero`.
- Un `ADMIN` que no es tesorero solo ve sus propias obligaciones y comprobantes (`personaFinancieraPermitida`). El tablero de inicio le devuelve `finanzas` y `cobranza` en `null`, y el panel oculta el grupo **Finanzas**, los accesos rápidos de cobro y egreso, y las tarjetas de cobranza y mora. Las rutas del panel (`/admin/cobros`, `/admin/ajustes`, `/admin/historial`) exigen `TESORERO`.
- **Cuenta del tesorero protegida:** un `ADMIN` no puede crear, modificar, bloquear, inactivar, eliminar, restablecer la contraseña ni quitar la verificación en dos pasos de una cuenta `TESORERO`, ni conceder el rol, mientras exista un tesorero activo. Solo el tesorero gestiona esa cuenta (`exigirPermisoSobreTesorero`).
- **Designación inicial:** si no hay ningún tesorero activo, un `ADMIN` puede designar al primero.
- La regla de "no dejar a la Junta sin administradores activos" cuenta `ADMIN` y `TESORERO` (`ROLES_DIRECTIVA`).
- `db:reset-admin <cédula>` y la creación del primer administrador en producción aceptan cuentas `ADMIN` o `TESORERO`.
- El seed crea a la "Tesorera" con el rol `TESORERO`; las pruebas E2E inician sesión con esa cuenta.

## Consecuencias

- **Al desplegar, nadie es tesorero** hasta que un `ADMIN` designe al primero. Mientras tanto, nadie accede a las finanzas.
- Si el tesorero pierde el acceso, se recupera con `npm run db:reset-admin -- <cédula>` en el servidor.
- Los datos financieros siguen guardándose igual; cambia solo quién puede leerlos y escribirlos. La auditoría registra las acciones del tesorero como las de cualquier cuenta.
