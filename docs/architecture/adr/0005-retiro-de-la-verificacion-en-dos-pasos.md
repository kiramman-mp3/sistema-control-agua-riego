# ADR 0005 — Retiro de la verificación en dos pasos

- **Estado:** aceptado. Reemplaza la parte de verificación en dos pasos del [ADR 0002](0002-sesion-en-cookie-y-verificacion-en-dos-pasos.md); la sesión en cookie HttpOnly con CSRF sigue vigente.
- **Fecha:** 2026-11-16.
- **Origen:** la directiva no quiere esta función en ninguna pantalla.

## Decisión

- Se elimina la verificación en dos pasos (TOTP) de todo el sistema. El inicio de sesión vuelve a ser solo cédula y contraseña.
- **Backend:** se quitan `totpController`, `services/totp`, las rutas `/api/auth/totp/*` y `/api/personas/:id/cuenta/totp/desactivar`, el token intermedio `VERIFICAR_TOTP` del middleware, el segundo paso del login (`requiereTotp`), el campo `totpActivo` de `/api/auth/me` y la dependencia `qrcode`.
- **Base de datos:** la migración `040_quitar_totp` elimina de `cuentas` las columnas `totp_secreto`, `totp_activo`, `totp_ultimo_paso` y `totp_recuperacion` (agregadas por la 037). Los secretos y los códigos de recuperación guardados se borran.
- **Frontend:** se quita el segundo paso de la pantalla de ingreso y el bloque «Verificación en dos pasos» de **Mi cuenta**.
- `npm run db:reset-admin` sigue generando una contraseña temporal; ya no tiene que desactivar nada.

## Consecuencias

- Las cuentas de la directiva, incluida la del tesorero, quedan protegidas solo por la contraseña, el bloqueo por intentos fallidos y la alerta de ataques distribuidos. Por eso conviene mantener contraseñas largas y no compartidas.
- Si más adelante se quiere volver a ofrecer, hay que reimplementarla; la migración 040 no se puede deshacer sin restaurar un respaldo anterior.
