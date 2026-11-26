export type SeccionFinanzas =
  | 'cobrar'
  | 'pagos'
  | 'egresos'
  | 'caja-previa'
  | 'historial'
  | 'deudores'
  | 'facturacion'
  | 'tarifas';
export type GrupoFinanzas = 'cobros' | 'ajustes' | 'historial';

export interface Seccion {
  id: SeccionFinanzas;
  etiqueta: string;
  icono: string;
}

export interface GrupoSecciones {
  id: GrupoFinanzas;
  etiqueta: string;
  descripcion: string;
  icono: string;
  /** Muestra los indicadores de caja (no aportan en la configuración de tarifas). */
  indicadores: boolean;
  secciones: Seccion[];
}

/**
 * Tres apartados del menú lateral, cada uno con su URL (/admin/cobros/egresos):
 * Cobros y pagos (caja, egresos y caja previa al sistema), Tarifas y pago anual (tarifas y pago anual de agua)
 * e Historial financiero (recibos, ingresos/egresos por año y deudores). `?nuevo=egreso` abre el formulario de egreso.
 */
export const GRUPOS_FINANZAS: GrupoSecciones[] = [
  {
    id: 'cobros',
    etiqueta: 'Cobros y pagos',
    icono: 'ri-hand-coin-line',
    indicadores: true,
    descripcion:
      'Cobro en caja a los usuarios, egresos de la Junta y la caja que ya existía antes del sistema.',
    secciones: [
      { id: 'cobrar', etiqueta: 'Cobrar', icono: 'ri-hand-coin-line' },
      { id: 'egresos', etiqueta: 'Egresos', icono: 'ri-shopping-bag-3-line' },
      { id: 'caja-previa', etiqueta: 'Caja previa', icono: 'ri-safe-2-line' },
    ],
  },
  {
    id: 'ajustes',
    etiqueta: 'Tarifas y pago anual',
    icono: 'ri-price-tag-3-line',
    indicadores: false,
    descripcion: 'Tarifas de agua, multas y demás conceptos, y emisión del pago anual de agua.',
    secciones: [
      { id: 'tarifas', etiqueta: 'Tarifas', icono: 'ri-price-tag-3-line' },
      { id: 'facturacion', etiqueta: 'Pago anual', icono: 'ri-calendar-2-line' },
    ],
  },
  {
    id: 'historial',
    etiqueta: 'Historial financiero',
    icono: 'ri-history-line',
    indicadores: true,
    descripcion:
      'Recibos de cobro, ingresos y egresos de la Junta por año, y quién debe agua y multas.',
    secciones: [
      { id: 'pagos', etiqueta: 'Recibos', icono: 'ri-file-list-3-line' },
      { id: 'historial', etiqueta: 'Ingresos y egresos', icono: 'ri-git-branch-line' },
      { id: 'deudores', etiqueta: 'Deudores', icono: 'ri-user-unfollow-line' },
    ],
  },
];

/** Apartado al que pertenece una sección (para redirigir las URL antiguas /admin/finanzas/…). */
export function grupoDeSeccion(seccion: string | undefined): GrupoSecciones {
  return (
    GRUPOS_FINANZAS.find((g) => g.secciones.some((s) => s.id === seccion)) ?? GRUPOS_FINANZAS[0]
  );
}
