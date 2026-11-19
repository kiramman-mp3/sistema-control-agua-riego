# ADR 0006 — Los usuarios con historial se ocultan en vez de borrarse

- **Estado:** aceptado.
- **Fecha:** 2026-11-19.
- **Origen:** la directiva pidió poder eliminar a los usuarios creados en pruebas y, en general, a cualquiera, con una confirmación para no hacerlo por error. La base guarda información histórica (lotes, cuotas, pagos, asistencias) que no debe quedar inconsistente.

## Decisión

- «Eliminar» un usuario pide confirmación y el servidor decide: **sin historial** se borra de verdad con su cuenta (libera la cédula); **con historial** se **oculta** del padrón sin tocar sus datos.
- Ocultar usa el estado `INACTIVO` ya existente (la cuenta deja de poder entrar) más dos columnas nuevas en `personas`: `oculta_en` y `oculta_por_cuenta_id` (migración `041_personas_ocultas`). El padrón excluye por defecto a los ocultos; `GET /api/personas?ocultos=solo` lista solo esos.
- Para ocultar, el usuario no debe tener **lotes** (se transfieren antes, para que ningún lote quede con un titular invisible), **sectores a su cargo** ni **deudas pendientes**. Si los tiene, se responde `409` con lo que falta.
- `POST /api/personas/:id/restaurar` lo devuelve al padrón activo con su historial intacto.
- Se mantienen las protecciones de inactivar: no a uno mismo, no al último administrador y la cuenta del tesorero solo la gobierna el tesorero. Todo queda en la auditoría (`ELIMINAR`, `OCULTAR`, `RESTAURAR`).
- La cédula de un usuario oculto sigue ocupada: registrarla de nuevo o editar otra a esa cédula responde `409` con `codigo: "PERSONA_OCULTA"` y el `personaId` para restaurarlo. Un usuario oculto no se puede editar hasta restaurarlo.

## Consecuencias

- Los usuarios de prueba sin movimientos desaparecen de verdad; los demás se conservan ocultos y recuperables.
- Un usuario con deudas pendientes o lotes no se puede ocultar: la directiva debe resolverlos primero, lo que evita deudas o lotes huérfanos.
