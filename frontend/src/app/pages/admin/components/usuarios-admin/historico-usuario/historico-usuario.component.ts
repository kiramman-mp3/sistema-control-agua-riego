import {
  Component,
  DestroyRef,
  Injector,
  afterNextRender,
  effect,
  inject,
  input,
  output,
  signal,
  untracked,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import { Subject, debounceTime, distinctUntilChanged, of, switchMap, catchError } from 'rxjs';
import { FinanzasService } from '../../../../../core/services/finanzas.service';
import { NotificationService } from '../../../../../core/services/notification.service';
import {
  EstadoLoteHistorico,
  GuardarHistorico,
  HistoricoUsuario,
  MESES,
  MontoHistorico,
  MultasHistoricoEnvio,
  UsuarioBusqueda,
} from '../../../../../core/models/finanzas';
import { hoyEnEcuador } from '../../../../../core/utils/fechas';
import { ModalComponent } from '../../../../../shared/ui/modal.component';
import { MonedaPipe } from '../../../../../shared/pipes/moneda.pipe';
import { AYUDAS_FORMULARIO } from '../../../../../core/directives/formularios';

/** Persona a la que se le registra el histórico (la fila del padrón o el resultado de la búsqueda). */
export interface PersonaHistorico {
  id: number;
  cedula: string;
  nombres: string;
  apellidos: string;
}

type Tipo = 'ASAMBLEA' | 'MINGA';
type Paso = 'agua' | 'anteriores' | 'multas';

/** Campos de multas de un tipo: el acumulado de años anteriores y un valor por mes del año en curso. */
interface FormMultas {
  anterior: number | null;
  meses: (number | null)[];
}

const redondear = (n: number) => Math.round(n * 100) / 100;
const valorDe = (m: MontoHistorico | null | undefined): number | null =>
  m ? Number(m.valor) : null;

/**
 * Registro del histórico de un usuario (lo que la Junta llevaba en papel): agua del año en curso por lote
 * (debe o ya pagó), acumulado de agua y multas de años anteriores, y multas del año en curso mes a mes.
 * Lo ya cobrado en caja no se puede modificar aquí.
 */
@Component({
  selector: 'app-historico-usuario',
  standalone: true,
  imports: [FormsModule, MonedaPipe, ...AYUDAS_FORMULARIO, ModalComponent],
  templateUrl: './historico-usuario.component.html',
})
export class HistoricoUsuarioComponent {
  private finanzas = inject(FinanzasService);
  private notify = inject(NotificationService);
  private destroyRef = inject(DestroyRef);
  private injector = inject(Injector);

  /** Usuario al que se registra el histórico; sin valor, el asistente empieza buscándolo. */
  readonly usuario = input<PersonaHistorico | null>(null);
  readonly cerrar = output<void>();
  readonly guardado = output<void>();

  readonly persona = signal<PersonaHistorico | null>(null);
  readonly datos = signal<HistoricoUsuario | null>(null);
  readonly cargando = signal(false);
  readonly guardando = signal(false);
  readonly errorCarga = signal('');
  readonly errorGuardado = signal('');

  // Búsqueda del usuario (paso 1 cuando no llega uno)
  readonly termino = signal('');
  readonly resultados = signal<UsuarioBusqueda[]>([]);
  readonly buscando = signal(false);
  private busqueda$ = new Subject<string>();

  /** Pestaña visible del formulario. */
  readonly paso = signal<Paso>('agua');

  readonly meses = MESES;
  readonly hoy = hoyEnEcuador();
  readonly tipos: { clave: Tipo; titulo: string }[] = [
    { clave: 'ASAMBLEA', titulo: 'Multas por asambleas' },
    { clave: 'MINGA', titulo: 'Multas por mingas' },
  ];

  // Formulario
  valorHectarea: number | null = null;
  estadoLote: Record<number, EstadoLoteHistorico> = {};
  aguaAnterior: number | null = null;
  multas: Record<Tipo, FormMultas> = {
    ASAMBLEA: { anterior: null, meses: [] },
    MINGA: { anterior: null, meses: [] },
  };

  constructor() {
    effect(() => {
      const u = this.usuario();
      untracked(() => {
        if (u) this.elegir(u);
        else this.enfocarBusqueda();
      });
    });

    this.busqueda$
      .pipe(
        debounceTime(250),
        distinctUntilChanged(),
        switchMap((texto) => {
          if (texto.length < 2) {
            this.buscando.set(false);
            return of(null);
          }
          this.buscando.set(true);
          return this.finanzas.buscarUsuarios(texto).pipe(catchError(() => of(null)));
        }),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe((res) => {
        this.buscando.set(false);
        this.resultados.set(res?.data ?? []);
      });
  }

  buscar(texto: string): void {
    this.termino.set(texto);
    const t = texto.trim();
    this.buscando.set(t.length >= 2);
    this.busqueda$.next(t);
  }

  elegir(p: PersonaHistorico): void {
    this.persona.set(p);
    this.resultados.set([]);
    this.cargar();
  }

  cambiarUsuario(): void {
    this.persona.set(null);
    this.datos.set(null);
    this.errorCarga.set('');
    this.buscar('');
    this.resultados.set([]);
    this.enfocarBusqueda();
  }

  /** Al buscar al usuario, el cursor queda listo en el campo: no en el botón de cerrar. */
  private enfocarBusqueda(): void {
    afterNextRender(() => document.getElementById('hist-busqueda')?.focus(), {
      injector: this.injector,
    });
  }

  cargar(): void {
    const p = this.persona();
    if (!p) return;
    this.cargando.set(true);
    this.errorCarga.set('');
    this.finanzas.getHistorico(p.id).subscribe({
      next: (res) => {
        this.llenar(res.data);
        this.datos.set(res.data);
        // Sin lotes no hay agua del año que anotar: se empieza por lo de años anteriores.
        this.paso.set(res.data.lotes.length ? 'agua' : 'anteriores');
        this.cargando.set(false);
      },
      error: (err) => {
        this.cargando.set(false);
        this.errorCarga.set(err.error?.message || 'No se pudo cargar el histórico del usuario.');
      },
    });
  }

  /** Precarga el formulario con lo que ya estaba registrado. */
  private llenar(d: HistoricoUsuario): void {
    this.valorHectarea = d.valor_hectarea_sugerido;
    this.estadoLote = Object.fromEntries(
      d.lotes.map((l) => [l.lote_id, l.cuota?.estado === 'PAGADA' ? 'PAGADA' : 'DEBE']),
    ) as Record<number, EstadoLoteHistorico>;
    this.aguaAnterior = valorDe(d.agua_anterior);
    for (const tipo of ['ASAMBLEA', 'MINGA'] as Tipo[]) {
      const origen = d.multas[tipo];
      this.multas[tipo] = {
        anterior: valorDe(origen.anterior),
        meses: Array.from({ length: d.mes_actual }, (_, i) => valorDe(origen.meses[String(i + 1)])),
      };
    }
  }

  /** La cuota ya se cobró con un recibo, está anulada o su valor ya se cobró: aquí no se puede cambiar. */
  bloqueadoLote(l: HistoricoUsuario['lotes'][number]): boolean {
    return (
      l.cuota?.estado === 'ANULADA' ||
      (l.cuota?.estado === 'PAGADA' && !l.cuota.pagada_antes_sistema)
    );
  }

  bloqueadoMonto(m: MontoHistorico | null | undefined): boolean {
    return m?.estado === 'PAGADA';
  }

  /** ¿El pago de la cuota de este año ya lleva el recargo del 10%? (después del 31 de marzo). */
  readonly conRecargo = (anio: number): boolean => this.hoy > `${anio}-03-31`;

  /** Cuota estimada de un lote con el valor por hectárea indicado. */
  cuotaDe(l: HistoricoUsuario['lotes'][number]): number | null {
    if (l.cuota) return l.cuota.valor_total;
    if (l.hectareas === null || !this.valorHectarea || this.valorHectarea <= 0) return null;
    return redondear(l.hectareas * this.valorHectarea);
  }

  /** Cuota que se debería hoy: la del lote más el recargo si corresponde. */
  adeudaDe(l: HistoricoUsuario['lotes'][number], anio: number): number {
    const base = this.cuotaDe(l) ?? 0;
    return this.conRecargo(anio) ? redondear(base * 1.1) : base;
  }

  iniciales(p: { nombres: string; apellidos: string }): string {
    return ((p.apellidos?.[0] ?? '') + (p.nombres?.[0] ?? '')).toUpperCase();
  }

  /** Agua del año en curso que quedará pendiente (lo que «debe», con el recargo si corresponde). */
  private subtotalAgua(): number {
    const d = this.datos();
    if (!d) return 0;
    return d.lotes
      .filter((l) => this.estadoLote[l.lote_id] === 'DEBE' && l.cuota?.estado !== 'ANULADA')
      .reduce((s, l) => s + this.adeudaDe(l, d.anio), 0);
  }

  /** Acumulado de años anteriores: agua y multas. */
  private subtotalAnteriores(): number {
    return (
      (this.aguaAnterior ?? 0) +
      (['ASAMBLEA', 'MINGA'] as Tipo[]).reduce((s, t) => s + (this.multas[t].anterior ?? 0), 0)
    );
  }

  /** Multas del año en curso, mes a mes. */
  private subtotalMultas(): number {
    return (['ASAMBLEA', 'MINGA'] as Tipo[]).reduce(
      (s, t) => s + this.multas[t].meses.reduce<number>((a, v) => a + (v ?? 0), 0),
      0,
    );
  }

  /** Pestañas del formulario, cada una con lo que suma. */
  pasos(): { id: Paso; titulo: string; subtotal: number }[] {
    const anio = this.datos()?.anio ?? '';
    return [
      { id: 'agua', titulo: `Agua ${anio}`, subtotal: redondear(this.subtotalAgua()) },
      { id: 'anteriores', titulo: 'Años anteriores', subtotal: redondear(this.subtotalAnteriores()) },
      { id: 'multas', titulo: `Multas ${anio}`, subtotal: redondear(this.subtotalMultas()) },
    ];
  }

  /** Total que quedará pendiente según lo que se ve en pantalla (agua del año con recargo + acumulados + multas). */
  totalPendiente(): number {
    if (!this.datos()) return 0;
    return redondear(this.subtotalAgua() + this.subtotalAnteriores() + this.subtotalMultas());
  }

  /** Errores de validación de los importes (no negativos, dos decimales como máximo). */
  errores(): string[] {
    const valores: [string, number | null][] = [
      ['El valor por hectárea', this.valorHectarea],
      ['El agua de años anteriores', this.aguaAnterior],
      ...(['ASAMBLEA', 'MINGA'] as Tipo[]).flatMap((t): [string, number | null][] => [
        [`Las multas de ${t === 'ASAMBLEA' ? 'asambleas' : 'mingas'} de años anteriores`, this.multas[t].anterior],
        ...this.multas[t].meses.map((v, i): [string, number | null] => [
          `La multa de ${t === 'ASAMBLEA' ? 'asambleas' : 'mingas'} de ${MESES[i].toLowerCase()}`,
          v,
        ]),
      ]),
    ];
    const errores: string[] = [];
    for (const [nombre, v] of valores) {
      if (v === null || v === undefined || (v as unknown) === '') continue;
      const n = Number(v);
      if (!Number.isFinite(n) || n < 0) errores.push(`${nombre} no puede ser negativo.`);
      else if (Math.round(n * 100) !== n * 100) errores.push(`${nombre} admite dos decimales como máximo.`);
    }
    return errores;
  }

  /** Valor a enviar: vacío no cambia nada, salvo que antes hubiera uno pendiente (entonces se quita con 0). */
  private envio(valor: number | null, previo: MontoHistorico | null | undefined): number | undefined {
    if (this.bloqueadoMonto(previo)) return undefined;
    if (valor === null || (valor as unknown) === '') return previo ? 0 : undefined;
    return Number(valor);
  }

  private multasEnvio(tipo: Tipo, d: HistoricoUsuario): MultasHistoricoEnvio {
    const f = this.multas[tipo];
    const previas = d.multas[tipo];
    const meses: Record<string, number> = {};
    f.meses.forEach((v, i) => {
      const e = this.envio(v, previas.meses[String(i + 1)]);
      if (e !== undefined) meses[String(i + 1)] = e;
    });
    const anterior = this.envio(f.anterior, previas.anterior);
    return { ...(anterior !== undefined ? { anterior } : {}), meses };
  }

  guardar(): void {
    const d = this.datos();
    const p = this.persona();
    if (!d || !p || this.guardando()) return;
    if (this.errores().length) return;

    const lotes = d.lotes
      .filter((l) => !this.bloqueadoLote(l))
      .map((l) => ({ lote_id: l.lote_id, estado: this.estadoLote[l.lote_id] ?? 'DEBE' }));
    const datos: GuardarHistorico = {
      lotes,
      valor_hectarea: this.valorHectarea && this.valorHectarea > 0 ? this.valorHectarea : null,
      multas_asamblea: this.multasEnvio('ASAMBLEA', d),
      multas_minga: this.multasEnvio('MINGA', d),
    };
    const agua = this.envio(this.aguaAnterior, d.agua_anterior);
    if (agua !== undefined) datos.agua_anterior = agua;

    this.guardando.set(true);
    this.errorGuardado.set('');
    this.finanzas.guardarHistorico(p.id, datos).subscribe({
      next: (res) => {
        this.guardando.set(false);
        this.notify.success(res.message || 'Histórico guardado.');
        this.guardado.emit();
      },
      error: (err) => {
        this.guardando.set(false);
        const lotesSin = err.error?.lotes_sin_superficie as { codigo: string }[] | undefined;
        this.errorGuardado.set(
          (err.error?.message || 'No se pudo guardar el histórico.') +
            (lotesSin?.length ? ` Lotes: ${lotesSin.map((l) => l.codigo).join(', ')}.` : ''),
        );
      },
    });
  }
}
