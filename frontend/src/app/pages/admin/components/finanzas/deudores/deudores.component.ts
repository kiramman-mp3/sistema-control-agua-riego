import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { FinanzasService } from '../../../../../core/services/finanzas.service';
import { NotificationService } from '../../../../../core/services/notification.service';
import { CARGADOR_JSPDF } from '../../../../../core/utils/jspdf';
import { Deudor, Deudores, MESES, MultasDeudor } from '../../../../../core/models/finanzas';
import { formatearFecha } from '../../../../../core/utils/fechas';
import { formatearDinero } from '../../../../../core/utils/dinero';
import { MonedaPipe } from '../../../../../shared/pipes/moneda.pipe';
import { FechaLocalPipe } from '../../../../../shared/pipes/fecha-local.pipe';

export type FiltroDeuda = 'TODOS' | 'AGUA' | 'ASAMBLEA' | 'MINGA';

const centavos = (n: number) => Math.round(Number(n) * 100);
const dolares = (c: number) => c / 100;

/**
 * Deudores del agua y de las multas de asambleas y mingas. Arriba, un resumen corto; abajo, el detalle por
 * usuario: el año en curso desglosado (el agua por lote con su recargo; las multas mes a mes) y lo de años
 * anteriores en un solo valor. Se puede filtrar, imprimir o descargar en PDF.
 */
@Component({
  selector: 'app-deudores',
  standalone: true,
  imports: [FormsModule, MonedaPipe, FechaLocalPipe],
  templateUrl: './deudores.component.html',
})
export class DeudoresComponent implements OnInit {
  private finanzas = inject(FinanzasService);
  private notify = inject(NotificationService);
  private cargadorPdf = inject(CARGADOR_JSPDF);

  readonly datos = signal<Deudores | null>(null);
  readonly cargando = signal(false);
  readonly error = signal('');
  readonly generandoPdf = signal(false);

  readonly texto = signal('');
  readonly filtro = signal<FiltroDeuda>('TODOS');
  readonly abiertos = signal<ReadonlySet<number>>(new Set());

  readonly meses = MESES;
  readonly filtros: { valor: FiltroDeuda; etiqueta: string }[] = [
    { valor: 'TODOS', etiqueta: 'Todo' },
    { valor: 'AGUA', etiqueta: 'Agua' },
    { valor: 'ASAMBLEA', etiqueta: 'Multas de asambleas' },
    { valor: 'MINGA', etiqueta: 'Multas de mingas' },
  ];

  /** Lo que debe el usuario del concepto filtrado (o todo). */
  valorDe(d: Deudor, filtro: FiltroDeuda = this.filtro()): number {
    switch (filtro) {
      case 'AGUA':
        return d.agua.total;
      case 'ASAMBLEA':
        return this.totalMultas(d.multas_asamblea);
      case 'MINGA':
        return this.totalMultas(d.multas_minga);
      default:
        return d.total;
    }
  }

  totalMultas(m: MultasDeudor): number {
    return dolares(centavos(m.actual) + centavos(m.anteriores));
  }

  readonly filtrados = computed(() => {
    const t = this.texto().trim().toLowerCase();
    const f = this.filtro();
    return (this.datos()?.deudores ?? []).filter(
      (d) =>
        this.valorDe(d, f) > 0 &&
        (!t || d.nombre.toLowerCase().includes(t) || d.cedula.includes(t)),
    );
  });

  readonly totalFiltrado = computed(() =>
    dolares(this.filtrados().reduce((s, d) => s + centavos(this.valorDe(d)), 0)),
  );

  ngOnInit(): void {
    this.cargar();
  }

  cargar(): void {
    this.cargando.set(true);
    this.error.set('');
    this.finanzas.getDeudores().subscribe({
      next: (res) => {
        this.datos.set(res.data);
        this.cargando.set(false);
      },
      error: (err) => {
        this.cargando.set(false);
        this.error.set(err.error?.message || 'No se pudo cargar el reporte de deudores.');
      },
    });
  }

  alternar(id: number): void {
    const nuevo = new Set(this.abiertos());
    if (nuevo.has(id)) nuevo.delete(id);
    else nuevo.add(id);
    this.abiertos.set(nuevo);
  }

  /** Imprime lo que se ve: el navegador oculta el resto de la página con los estilos de impresión. */
  imprimir(): void {
    window.print();
  }

  async descargarPdf(): Promise<void> {
    const d = this.datos();
    if (!d || this.generandoPdf()) return;
    this.generandoPdf.set(true);
    try {
      const { jsPDF, autoTable } = await this.cargadorPdf();
      const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });
      const ancho = doc.internal.pageSize.getWidth();
      doc.setFontSize(14);
      doc.text('Junta de Agua y Riego "La Jones" · Deudores', 14, 15);
      doc.setFontSize(9);
      const etiqueta = this.filtros.find((f) => f.valor === this.filtro())?.etiqueta ?? 'Todo';
      doc.text(
        `Corte al ${formatearFecha(d.fecha)} · ${etiqueta} · ${this.filtrados().length} usuarios · Total ${formatearDinero(this.totalFiltrado())}`,
        14,
        21,
      );
      doc.text(
        'El agua pendiente incluye el recargo del 10% de las cuotas pagadas después del 31 de marzo de su año.',
        14,
        26,
      );
      const fila = (x: Deudor) => [
        x.nombre,
        x.cedula,
        formatearDinero(x.agua.actual + x.agua.recargo_actual),
        formatearDinero(x.agua.anteriores),
        formatearDinero(x.multas_asamblea.actual),
        formatearDinero(x.multas_asamblea.anteriores),
        formatearDinero(x.multas_minga.actual),
        formatearDinero(x.multas_minga.anteriores),
        formatearDinero(this.valorDe(x)),
      ];
      autoTable(doc, {
        startY: 30,
        head: [
          [
            'Usuario',
            'Cédula',
            `Agua ${d.anio}`,
            'Agua anteriores',
            `Asambleas ${d.anio}`,
            'Asambleas anteriores',
            `Mingas ${d.anio}`,
            'Mingas anteriores',
            'Total',
          ],
        ],
        body: this.filtrados().map(fila),
        styles: { fontSize: 8 },
        headStyles: { fillColor: [23, 78, 110] },
        columnStyles: Object.fromEntries(
          [2, 3, 4, 5, 6, 7, 8].map((i) => [i, { halign: 'right' as const }]),
        ),
        margin: { left: 14, right: 14 },
        didDrawPage: () => {
          doc.setFontSize(8);
          doc.text(`Página ${doc.getNumberOfPages()}`, ancho - 14, doc.internal.pageSize.getHeight() - 8, {
            align: 'right',
          });
        },
      });
      doc.save(`Deudores_${d.fecha}.pdf`);
    } catch {
      this.notify.error('No se pudo generar el PDF. Intente de nuevo.');
    } finally {
      this.generandoPdf.set(false);
    }
  }
}
