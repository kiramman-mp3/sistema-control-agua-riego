const express = require('express');
const financieroController = require('../controllers/financieroController');
const comprobantes = require('../controllers/pagoComprobanteController');
const { recibirArchivo } = require('../services/documentStorage');
const { verificarToken, soloTesorero } = require('../middlewares/authMiddleware');

const router = express.Router();

/**
 * @openapi
 * /financiero/conceptos:
 *   get:
 *     tags: [Gestión Financiera]
 *     summary: Conceptos de cobro con su tarifa vigente
 *     security: [{ bearerAuth: [] }]
 * /financiero/tarifas:
 *   get:
 *     tags: [Gestión Financiera]
 *     summary: Historial de tarifas por concepto
 *     security: [{ bearerAuth: [] }]
 *   post:
 *     tags: [Gestión Financiera]
 *     summary: Registrar tarifa (cierra la vigencia de la anterior)
 *     security: [{ bearerAuth: [] }]
 */
router.get('/conceptos', verificarToken, financieroController.getConceptos);
router.get('/tarifas', ...soloTesorero, financieroController.getTarifas);
router.post('/tarifas', ...soloTesorero, financieroController.createTarifa);

/**
 * @openapi
 * /financiero/obligaciones:
 *   get:
 *     tags: [Gestión Financiera]
 *     summary: Cuentas por cobrar. El administrador ve todas; un usuario solo las suyas.
 *     security: [{ bearerAuth: [] }]
 *   post:
 *     tags: [Gestión Financiera]
 *     summary: Crear obligación manual
 *     security: [{ bearerAuth: [] }]
 * /financiero/obligaciones/{id}/anular:
 *   post:
 *     tags: [Gestión Financiera]
 *     summary: Anular obligación pendiente
 *     security: [{ bearerAuth: [] }]
 * /financiero/obligaciones/multas:
 *   get:
 *     tags: [Gestión Financiera]
 *     summary: Multas y otros cobros de un usuario por cédula
 *     security: [{ bearerAuth: [] }]
 */
router.get('/obligaciones', verificarToken, financieroController.getObligaciones);
router.post('/obligaciones', ...soloTesorero, financieroController.createObligacionManual);
router.get('/obligaciones/multas', ...soloTesorero, financieroController.getObligacionesMultas);
router.post('/obligaciones/:id/anular', ...soloTesorero, financieroController.anularObligacion);

/**
 * @openapi
 * /financiero/pagos:
 *   get:
 *     tags: [Gestión Financiera]
 *     summary: Pagos registrados. El administrador ve todos; un usuario solo los suyos.
 *     security: [{ bearerAuth: [] }]
 *   post:
 *     tags: [Gestión Financiera]
 *     summary: Registrar pago completo por transferencia o depósito, con referencia bancaria obligatoria
 *     security: [{ bearerAuth: [] }]
 * /financiero/pagos/{id}/anular:
 *   post:
 *     tags: [Gestión Financiera]
 *     summary: Anular pago y devolver sus obligaciones a PENDIENTE
 *     security: [{ bearerAuth: [] }]
 */
router.get('/pagos', verificarToken, financieroController.getPagos);
router.get('/pagos/:id', verificarToken, financieroController.getPagoById);
/**
 * @openapi
 * /financiero/pagos/{id}/comprobante:
 *   post:
 *     tags: [Gestión Financiera]
 *     summary: Adjuntar o reemplazar comprobante bancario de un pago vigente (TESORERO)
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: integer } }
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             required: [archivo]
 *             properties:
 *               archivo: { type: string, format: binary, description: 'PDF/JPG/PNG, hasta 10 MB' }
 *     responses:
 *       '200': { description: Comprobante guardado }
 *   get:
 *     tags: [Gestión Financiera]
 *     summary: Descargar comprobante bancario (TESORERO o titular del pago)
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: integer } }
 *     responses:
 *       '200': { description: Archivo del comprobante bancario }
 */
router.post('/pagos/:id/comprobante', ...soloTesorero, recibirArchivo, comprobantes.general.subir);
router.get('/pagos/:id/comprobante', verificarToken, comprobantes.general.descargar);
router.post('/pagos', ...soloTesorero, financieroController.registrarPago);
router.post('/pagos/:id/anular', ...soloTesorero, financieroController.anularPago);

/**
 * @openapi
 * /financiero/egresos:
 *   get:
 *     tags: [Gestión Financiera]
 *     summary: Egresos y gastos
 *     security: [{ bearerAuth: [] }]
 *   post:
 *     tags: [Gestión Financiera]
 *     summary: Registrar egreso
 *     security: [{ bearerAuth: [] }]
 * /financiero/balance:
 *   get:
 *     tags: [Gestión Financiera]
 *     summary: Balance de ingresos, egresos y cartera pendiente
 *     security: [{ bearerAuth: [] }]
 * /financiero/historial:
 *   get:
 *     tags: [Gestión Financiera]
 *     summary: Historial anual de ingresos, egresos y balance agrupado por mes
 *     security: [{ bearerAuth: [] }]
 */
router.get('/egresos', ...soloTesorero, financieroController.getEgresos);
router.post('/egresos', ...soloTesorero, financieroController.createEgreso);
router.post('/egresos/:id/anular', ...soloTesorero, financieroController.anularEgreso);
router.get('/balance', ...soloTesorero, financieroController.getBalanceReport);
router.get('/historial', ...soloTesorero, financieroController.getHistorialAnual);
/**
 * @openapi
 * /financiero/agua-anual/obligaciones:
 *   post:
 *     tags: [Gestión Financiera]
 *     summary: Emitir (o simular con simular=true) la obligación anual de agua del año para los usuarios activos con lote (TESORERO). La cuota de cada lote es el valor por hectárea por sus hectáreas (m² / 10.000). Sin valor_hectarea usa la tarifa AGUA_ANUAL (por hectárea) vigente al 1 de enero.
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [anio]
 *             properties:
 *               anio: { type: integer, example: 2026 }
 *               valor_hectarea: { type: number, example: 55 }
 *               simular: { type: boolean, example: false }
 *     responses:
 *       '201': { description: Obligaciones generadas; las ya existentes del año se respetan }
 *       '409': { description: Hay lotes sin superficie; la respuesta incluye lotes_sin_superficie y no se emite ninguna }
 * /financiero/agua-anual/resumen:
 *   get:
 *     tags: [Gestión Financiera]
 *     summary: Obligaciones anuales de agua emitidas, cobradas y pendientes de un año (TESORERO)
 *     security: [{ bearerAuth: [] }]
 * /financiero/agua-anual/obligaciones/{personaId}:
 *   get:
 *     tags: [Gestión Financiera]
 *     summary: Obligaciones anuales de agua pendientes de un usuario (TESORERO)
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: path, name: personaId, required: true, schema: { type: integer } }
 * /financiero/agua-anual/pagos:
 *   post:
 *     tags: [Gestión Financiera]
 *     summary: Registrar el pago de obligaciones anuales de agua por transferencia o depósito (TESORERO). Multipart con el campo archivo (comprobante bancario, obligatorio) y los datos del pago; obligacionesIds va como texto JSON.
 *     security: [{ bearerAuth: [] }]
 *   get:
 *     tags: [Gestión Financiera]
 *     summary: Pagos anuales de agua (filtros desde, hasta, estado, persona_id). Un usuario solo ve los suyos.
 *     security: [{ bearerAuth: [] }]
 * /financiero/agua-anual/pagos/{id}:
 *   get:
 *     tags: [Gestión Financiera]
 *     summary: Detalle de un pago anual de agua para reimprimir su comprobante (TESORERO o titular)
 *     security: [{ bearerAuth: [] }]
 * /financiero/agua-anual/pagos/{id}/anular:
 *   post:
 *     tags: [Gestión Financiera]
 *     summary: Anular un pago anual de agua y devolver sus obligaciones a PENDIENTE (TESORERO)
 *     security: [{ bearerAuth: [] }]
 * /financiero/agua-anual/obligaciones/{id}/anular:
 *   post:
 *     tags: [Gestión Financiera]
 *     summary: Anular una obligación anual de agua pendiente (TESORERO)
 *     security: [{ bearerAuth: [] }]
 */
router.post('/agua-anual/pagos/:id/comprobante', ...soloTesorero, recibirArchivo, comprobantes.agua.subir);
router.get('/agua-anual/pagos/:id/comprobante', verificarToken, comprobantes.agua.descargar);
router.get('/agua-anual/resumen', ...soloTesorero, financieroController.getResumenAnualAgua);
router.post('/agua-anual/obligaciones', ...soloTesorero, financieroController.generarObligacionesAnualesAgua);
router.get('/agua-anual/obligaciones/:personaId', ...soloTesorero, financieroController.getObligacionesAnualesAgua);
router.post('/agua-anual/obligaciones/:id/anular', ...soloTesorero, financieroController.anularObligacionAnualAgua);
router.get('/agua-anual/pagos', verificarToken, financieroController.getPagosAnualesAgua);
router.get('/agua-anual/pagos/:id', verificarToken, financieroController.getPagoAnualAguaById);
router.post('/agua-anual/pagos', ...soloTesorero, recibirArchivo, financieroController.registrarPagoAnualAgua);
router.post('/agua-anual/pagos/:id/anular', ...soloTesorero, financieroController.anularPagoAnualAgua);

module.exports = router;
