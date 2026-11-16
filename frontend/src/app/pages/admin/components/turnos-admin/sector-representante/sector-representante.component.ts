import { Component, DestroyRef, OnInit, inject, input, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Subject, catchError, debounceTime, of, switchMap, tap } from 'rxjs';
import { AdminService } from '../../../../../core/services/admin.service';
import { NotificationService } from '../../../../../core/services/notification.service';
import { PersonaListado } from '../../../../../core/models/api-payloads';
import { ModalComponent } from '../../../../../shared/ui/modal.component';

/**
 * Designación del representante de un sector: la persona que recibe el turno de agua en nombre de
 * todos los usuarios del sector. Se busca en el servidor (máximo 20 resultados).
 */
@Component({
  selector: 'app-sector-representante',
  standalone: true,
  imports: [FormsModule, ModalComponent],
  template: `
    <app-modal
      titulo="Representante del sector"
      [subtitulo]="sector().nombre"
      icono="ri-user-star-line"
      tamano="sm"
      [bloqueado]="guardando()"
      (cerrar)="cerrar.emit()"
    >
      <div class="modal__body form-stack">
        <p class="text-muted">
          Actual:
          <strong>{{ sector().representante || 'Sin representante designado' }}</strong>
        </p>
        <div class="search-field">
          <i class="ri-search-line" aria-hidden="true"></i>
          <input
            type="search"
            class="input"
            placeholder="Nombre o cédula…"
            [(ngModel)]="busqueda"
            (ngModelChange)="buscar($event)"
            aria-label="Buscar usuario"
          />
        </div>
        <div
          class="picker__list"
          role="listbox"
          aria-label="Usuarios"
          [class.is-refreshing]="buscando()"
        >
          @for (u of usuarios(); track u.id) {
            <button
              type="button"
              role="option"
              class="picker__option"
              [class.is-selected]="seleccionado()?.id === u.id"
              [attr.aria-selected]="seleccionado()?.id === u.id"
              (click)="seleccionado.set(u)"
            >
              <span class="avatar" aria-hidden="true"
                >{{ (u.nombres || '').charAt(0) }}{{ (u.apellidos || '').charAt(0) }}</span
              >
              <span class="picker__text">
                <strong>{{ u.nombres }} {{ u.apellidos }}</strong>
                <span>C.I. {{ u.cedula }}</span>
              </span>
              @if (seleccionado()?.id === u.id) {
                <i class="ri-checkbox-circle-fill picker__check" aria-hidden="true"></i>
              }
            </button>
          } @empty {
            @if (!buscando()) {
              <p class="picker__empty">No se encontraron usuarios que coincidan.</p>
            }
          }
        </div>
      </div>
      <div class="modal__footer">
        @if (sector().representante) {
          <button
            type="button"
            class="btn btn--outline btn--danger"
            (click)="guardar(null)"
            [disabled]="guardando()"
          >
            Quitar representante
          </button>
        }
        <button type="button" class="btn btn--outline" data-cancelar [disabled]="guardando()">
          Cancelar
        </button>
        <button
          type="button"
          class="btn btn--primary"
          (click)="guardar(seleccionado()?.id ?? null)"
          [disabled]="guardando() || !seleccionado()"
        >
          <i class="ri-save-line" aria-hidden="true"></i> Designar
        </button>
      </div>
    </app-modal>
  `,
})
export class SectorRepresentanteComponent implements OnInit {
  private admin = inject(AdminService);
  private notify = inject(NotificationService);
  private destroyRef = inject(DestroyRef);

  readonly sector = input.required<{ id: number; nombre: string; representante: string }>();
  readonly cerrar = output<void>();
  readonly guardado = output<void>();

  readonly usuarios = signal<PersonaListado[]>([]);
  readonly buscando = signal(false);
  readonly guardando = signal(false);
  readonly seleccionado = signal<PersonaListado | null>(null);
  busqueda = '';

  private busqueda$ = new Subject<string>();

  ngOnInit(): void {
    this.busqueda$
      .pipe(
        debounceTime(250),
        tap(() => this.buscando.set(true)),
        switchMap((termino) =>
          this.admin.getPersonas(1, 20, termino, 'ACTIVO').pipe(catchError(() => of(null))),
        ),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe((res) => {
        this.buscando.set(false);
        this.usuarios.set(res?.data ?? []);
        if (!res) this.notify.error('No se pudo buscar usuarios. Revise su conexión.');
      });
    this.busqueda$.next('');
  }

  buscar(termino: string): void {
    this.busqueda$.next(termino.trim());
  }

  guardar(personaId: number | null): void {
    if (this.guardando()) return;
    this.guardando.set(true);
    this.admin.asignarRepresentante(this.sector().id, personaId).subscribe({
      next: (res) => {
        this.guardando.set(false);
        this.notify.success(res.message || 'Representante actualizado.');
        this.guardado.emit();
      },
      error: (err) => {
        this.guardando.set(false);
        this.notify.error(err.error?.message || 'No se pudo actualizar el representante.');
      },
    });
  }
}
