const express = require('express');
const turnoController = require('../controllers/turnoController');
const { verificarToken, soloAdmin } = require('../middlewares/authMiddleware');

const router = express.Router();

/**
 * @openapi
 * /turnos:
 *   get:
 *     tags: [Turnos de Agua]
 *     summary: Turnos activos por sector. La directiva ve todos; un usuario solo los de sus sectores.
 *     security: [{ bearerAuth: [] }]
 *   post:
 *     tags: [Turnos de Agua]
 *     summary: Crear turno semanal del sector (sin cruces de horario)
 *     security: [{ bearerAuth: [] }]
 * /turnos/sectores/{id}/representante:
 *   put:
 *     tags: [Turnos de Agua]
 *     summary: Designar o quitar (persona_id null) al representante del sector que recibe el turno
 *     security: [{ bearerAuth: [] }]
 * /turnos/{id}:
 *   put:
 *     tags: [Turnos de Agua]
 *     summary: Modificar turno
 *     security: [{ bearerAuth: [] }]
 *   delete:
 *     tags: [Turnos de Agua]
 *     summary: Desactivar turno de agua (desactivación lógica para trazabilidad e historial)
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *         description: ID numérico del turno a desactivar
 *     responses:
 *       200:
 *         description: Turno de agua desactivado exitosamente (estado pasa a INACTIVO)
 *       404:
 *         description: Turno no encontrado o ya desactivado
 */
router.put('/sectores/:id/representante', ...soloAdmin, turnoController.setRepresentante);
router.get('/cronograma', ...soloAdmin, turnoController.getCronogramaPorSectores);
router.get('/cronograma-publico', turnoController.getCronogramaPublico);
router.get('/', verificarToken, turnoController.getTurnos);
router.post('/', ...soloAdmin, turnoController.createTurno);
router.put('/:id', ...soloAdmin, turnoController.updateTurno);
router.delete('/:id', ...soloAdmin, turnoController.deleteTurno);

module.exports = router;
