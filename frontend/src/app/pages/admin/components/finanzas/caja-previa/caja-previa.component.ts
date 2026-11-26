import { Component, OnInit, computed, inject, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { FinanzasService } from '../../../../../core/services/finanzas.service';
import { DialogService } from '../../../../../core/services/dialog.service';
import { NotificationService } from '../../../../../core/services/notification.service';
import { ModalA11yDirective } from '../../../../../core/directives/modal-a11y.directive';
import { IngresoPrevio } from '../../../../../core/models/finanzas';
import { hoyEnEcuador } from '../../../../../core/utils/fechas';
import { formatearDinero } from '../../../../../core/utils/dinero';
import { FechaLocalPipe } from '../../../../../shared/pipes/fecha-local.pipe';
import { MonedaPipe } from '../../../../../shared/pipes/moneda.pipe';
import { AYUDAS_FORMULARIO } from '../../../../../core/directives/formularios';

interface FormCajaPrevia {
  fecha: string;
  valor: number | null;
  descripcion: string;
}

const formVacio = (): FormCajaPrevia => ({ fecha: hoyEnEcuador(), valor: null, descripcion: '' });

/**
 * Caja previa al sistema: el total que la Junta ya tenía en caja (pagos hechos en papel). Se anota como un
 * valor aparte, no como pagos: suma al saldo de caja y al historial, pero no crea recibos ni cobros.
 */
@Component({
  selector: 'app-caja-previa',
  standalone: true,
  imports: [FormsModule, ...AYUDAS_FORMULARIO, MonedaPipe, FechaLocalPipe, ModalA11yDirective],
  template: `
    <section class="fin-panel" aria-labelledby="caja-previa-titulo">
      <div class="fin-panel__head">
        <div>
          <h3 class="fin-panel__title" id="caja-previa-titulo">
            <i class="ri-safe-2-line" aria-hidden="true"></i> Caja previa al sistema
          </h3>
          <p class="fin-panel__desc">
            Total que la Junta ya tenía en caja antes del sistema: <strong class="money">{{ total() | moneda }}</strong>.
            Se suma al saldo de caja, pero no crea recibos ni pagos.
          </p>
        </div>
        <button type="button" class="btn btn--primary pressable" (click)="abrir()">
          <i class="ri-add-line" aria-hidden="true"></i> Registrar valor
        </button>
      </div>

      @if (error()) {
        <div class="alert alert--danger" role="alert">
          {{ error() }}
          <button type="button" class="btn btn--outline btn--sm" (click)="cargar()">Reintentar</button>
        </div>
      } @else if (cargando() && !registros().length) {
        <div aria-live="polite">
          <div class="skeleton skeleton--text"></div>
          <div class="skeleton skeleton--text"></div>
        </div>
      } @else if (!registros().length) {
        <div class="empty-state">
          <i class="ri-inbox-line" aria-hidden="true"></i>
          <strong>Sin registros</strong>
          <p>
            Anote aquí el dinero que la Junta tenía en caja al empezar a usar el sistema, por
            ejemplo lo recaudado en papel durante el año.
          </p>
        </div>
      } @else {
        <div class="table-scroll" tabindex="0" role="region" aria-label="Caja previa al sistema">
          <table class="fin-table">
            <thead>
              <tr>
                <th scope="col">Fecha</th>
                <th scope="col">Descripción</th>
                <th scope="col">Registró</th>
                <th scope="col" class="num">Valor</th>
                <th scope="col"><span class="sr-only">Acciones</span></th>
              </tr>
            </thead>
            <tbody>
              @for (r of registros(); track r.id) {
                <tr [class.fin-table__row--anulada]="r.estado === 'ANULADO'">
                  <td>{{ r.fecha | fechaLocal }}</td>
                  <td>
                    {{ r.descripcion }}
                    @if (r.estado === 'ANULADO') {
                      <br /><span class="fin-table__muted">Anulado: {{ r.motivo_anulacion }}</span>
                    }
                  </td>
                  <td>{{ r.registrado_por_usuario || '—' }}</td>
                  <td class="num">
                    <span class="money">{{ r.valor | moneda }}</span>
                  </td>
                  <td>
                    @if (r.estado === 'VIGENTE') {
                      <button
                        type="button"
                        class="btn btn--outline btn--sm"
                        [disabled]="procesando() === r.id"
                        (click)="anular(r)"
                      >
                        Anular
                      </button>
                    } @else {
                      <span class="badge badge--neutral">Anulado</span>
                    }
                  </td>
                </tr>
              }
            </tbody>
          </table>
        </div>
      }
    </section>

    @if (formularioVisible()) {
      <div appModalA11y class="sheet-backdrop" aria-labelledby="caja-previa-form-titulo">
        <form class="sheet" (ngSubmit)="guardar()" novalidate #formulario="ngForm">
          <div class="sheet__header">
            <h3 id="caja-previa-form-titulo">Registrar caja previa</h3>
            <button
              type="button"
              class="btn-close"
              (click)="cerrar(formulario.dirty)"
              aria-label="Cerrar"
            >
              <i class="ri-close-line" aria-hidden="true"></i>
            </button>
          </div>
          <div class="sheet__body">
            <p class="form-legend"><span class="req" aria-hidden="true">*</span> Campos obligatorios</p>
            <div class="field-row">
              <div class="field">
                <label for="caja-fecha">Fecha <span class="req" aria-hidden="true">*</span></label>
                <input
                  id="caja-fecha"
                  name="fecha"
                  class="input"
                  type="date"
                  [max]="hoy"
                  [(ngModel)]="form.fecha"
                />
                @if (errorDe('fecha')) {
                  <span class="field__error">{{ errorDe('fecha') }}</span>
                }
              </div>
              <div class="field">
                <label for="caja-valor"
                  >Valor (USD) <span class="req" aria-hidden="true">*</span></label
                >
                <input
                  id="caja-valor"
                  name="valor"
                  class="input money"
                  type="number"
                  inputmode="decimal"
                  min="0"
                  step="0.01"
                  placeholder="Ej. 1250.00"
                  [(ngModel)]="form.valor"
                />
                @if (errorDe('valor')) {
                  <span class="field__error">{{ errorDe('valor') }}</span>
                }
              </div>
            </div>
            <div class="field">
              <label for="caja-descripcion"
                >Descripción <span class="req" aria-hidden="true">*</span></label
              >
              <textarea
                id="caja-descripcion"
                name="descripcion"
                class="input"
                rows="3"
                maxlength="255"
                placeholder="Ej. Total en caja al empezar el sistema (pagos del agua 2026 recibidos en papel)"
                [(ngModel)]="form.descripcion"
              ></textarea>
              @if (errorDe('descripcion')) {
                <span class="field__error">{{ errorDe('descripcion') }}</span>
              }
            </div>
          </div>
          <div class="sheet__footer">
            <button
              type="button"
              class="btn btn--outline pressable"
              (click)="cerrar(formulario.dirty)"
              [disabled]="guardando()"
            >
              Cancelar
            </button>
            <button type="submit" class="btn btn--primary pressable" [disabled]="guardando()">
              {{ guardando() ? 'Guardando…' : 'Registrar' }}
            </button>
          </div>
        </form>
      </div>
    }
  `,
})
export class CajaPreviaComponent implements OnInit {
  private finanzas = inject(FinanzasService);
  private notify = inject(NotificationService);
  private dialog = inject(DialogService);

  /** Se emite al guardar o anular, para refrescar los indicadores de caja. */
  readonly cambiado = output<void>();

  readonly hoy = hoyEnEcuador();
  readonly registros = signal<IngresoPrevio[]>([]);
  readonly cargando = signal(false);
  readonly error = signal('');
  readonly formularioVisible = signal(false);
  readonly guardando = signal(false);
  readonly intentoGuardar = signal(false);
  readonly procesando = signal<number | null>(null);
  form: FormCajaPrevia = formVacio();

  /** Suma de los registros vigentes, en centavos para no arrastrar error de coma flotante. */
  readonly total = computed(
    () =>
      this.registros()
        .filter((r) => r.estado === 'VIGENTE')
        .reduce((s, r) => s + Math.round(Number(r.valor) * 100), 0) / 100,
  );

  ngOnInit(): void {
    this.cargar();
  }

  cargar(): void {
    this.cargando.set(true);
    this.error.set('');
    this.finanzas.getIngresosPrevios().subscribe({
      next: (res) => {
        this.registros.set(res.data.map((r) => ({ ...r, valor: Number(r.valor) })));
        this.cargando.set(false);
      },
      error: (err) => {
        this.cargando.set(false);
        this.error.set(err.error?.message || 'No se pudo cargar la caja previa.');
      },
    });
  }

  abrir(): void {
    this.form = formVacio();
    this.intentoGuardar.set(false);
    this.formularioVisible.set(true);
  }

  async cerrar(sinGuardar: boolean | null = false): Promise<void> {
    if (this.guardando()) return;
    if (sinGuardar && !(await this.dialog.confirmarDescartar())) return;
    this.formularioVisible.set(false);
  }

  errores(): Partial<Record<keyof FormCajaPrevia, string>> {
    const f = this.form;
    const errores: Partial<Record<keyof FormCajaPrevia, string>> = {};
    if (!f.fecha) errores.fecha = 'Indique la fecha.';
    else if (f.fecha > this.hoy) errores.fecha = 'La fecha no puede ser futura.';
    const valor = Number(f.valor);
    if (f.valor === null || !Number.isFinite(valor) || valor <= 0)
      errores.valor = 'Ingrese un valor mayor a cero.';
    else if (Math.round(valor * 100) !== valor * 100)
      errores.valor = 'Use como máximo dos decimales.';
    if (f.descripcion.trim().length < 5)
      errores.descripcion = 'Describa el origen del valor (mínimo 5 caracteres).';
    return errores;
  }

  errorDe(campo: keyof FormCajaPrevia): string {
    return this.intentoGuardar() ? (this.errores()[campo] ?? '') : '';
  }

  guardar(): void {
    this.intentoGuardar.set(true);
    if (Object.keys(this.errores()).length || this.guardando()) return;
    this.guardando.set(true);
    this.finanzas
      .registrarIngresoPrevio({
        fecha: this.form.fecha,
        valor: Number(this.form.valor),
        descripcion: this.form.descripcion.trim(),
      })
      .subscribe({
        next: (res) => {
          this.guardando.set(false);
          this.formularioVisible.set(false);
          this.notify.success(res.message || 'Caja previa registrada.');
          this.cargar();
          this.cambiado.emit();
        },
        error: (err) => {
          this.guardando.set(false);
          this.notify.error(err.error?.message || 'No se pudo registrar el valor.');
        },
      });
  }

  async anular(r: IngresoPrevio): Promise<void> {
    if (r.estado === 'ANULADO' || this.procesando() !== null) return;
    const motivo = await this.dialog.solicitar({
      titulo: 'Anular registro de caja previa',
      mensaje: `El valor de ${formatearDinero(r.valor)} dejará de sumarse al saldo de caja. Indique el motivo (mínimo 5 caracteres).`,
      placeholder: 'Motivo de la anulación',
      textoConfirmar: 'Anular',
      tipo: 'DANGER',
      validar: (texto) =>
        texto.trim().length < 5 ? 'Describa el motivo con al menos 5 caracteres.' : null,
    });
    if (!motivo?.trim()) return;
    this.procesando.set(r.id);
    this.finanzas.anularIngresoPrevio(r.id, motivo.trim()).subscribe({
      next: (res) => {
        this.procesando.set(null);
        this.notify.success(res.message || 'Registro anulado.');
        this.cargar();
        this.cambiado.emit();
      },
      error: (err) => {
        this.procesando.set(null);
        this.notify.error(err.error?.message || 'No se pudo anular el registro.');
      },
    });
  }
}
