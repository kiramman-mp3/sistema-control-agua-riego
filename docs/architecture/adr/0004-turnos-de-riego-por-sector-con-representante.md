# ADR 0004 — Turnos de riego por sector, con un representante

- **Estado:** aceptado.
- **Fecha:** 2026-11-16.
- **Origen:** pedido de la comunidad: los turnos de agua son por sector; el agua la recibe el representante del sector, no cada usuario por separado.

## Contexto

Cada turno de `turnos_riego` pertenecía a una persona y a uno de sus lotes. El agua de un sector llega por un mismo canal a todos sus usuarios, así que asignar horarios lote por lote no refleja cómo se reparte el riego.

## Decisión

- El turno es del **sector**: `turnos_riego.sector_id` (migración `039_turnos_por_sector`). Dos turnos activos del mismo sector no pueden cruzarse, considerando los que cruzan la medianoche y el paso de domingo a lunes.
- Cada sector tiene un **representante**: `sectores.representante_persona_id` (nullable, `ON DELETE SET NULL`). Debe ser una persona activa. Se designa o se quita con `PUT /api/turnos/sectores/:id/representante` (directiva) y queda en la auditoría.
- La migración agrupa los turnos existentes por el sector de su lote. Un turno sin lote queda `INACTIVO` como historial. `persona_id` pasa a ser opcional y `lote_id` queda como dato histórico; el sistema ya no los usa.
- Los turnos ya no siguen al titular de un lote cuando se transfiere: no dependen de nadie.
- El cronograma completo (`GET /api/turnos/cronograma`) agrega el representante (nombre y cédula) y lista todos los sectores activos, incluso sin turnos. El **cronograma público** muestra solo el horario del sector, sin datos personales.
- Un usuario consulta los turnos de los sectores donde tiene lotes o que representa (`GET /api/turnos`, "Mis lotes").
- El seed crea tres horarios semanales por sector y designa como representante al usuario activo con más lotes en él.

## Consecuencias

- Al desplegar, los sectores quedan sin representante hasta que la directiva lo designe; los turnos existentes se conservan, agrupados por sector.
- Un sector no se puede eliminar mientras tenga turnos activos.
- Una persona que representa un sector no se elimina físicamente: se inactiva.
