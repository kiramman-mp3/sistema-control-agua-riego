import { Component, input, output } from '@angular/core';
import { Turno } from '../turno.model';

/** Vista en tabla de los turnos (se apila como tarjetas en pantallas angostas). */
@Component({
  selector: 'app-turnos-tabla',
  standalone: true,
  template: `
    <div class="table-container table-container--flush">
      <table class="table-custom table-custom--stack">
        <thead>
          <tr>
            <th>Sector</th>
            <th>Representante</th>
            <th>Día</th>
            <th>Horario</th>
            <th><span class="sr-only">Acciones</span></th>
          </tr>
        </thead>
        <tbody>
          @for (t of turnos(); track t.id) {
            <tr>
              <td data-label="Sector">
                <strong>{{ t.sector }}</strong>
              </td>
              <td data-label="Representante">
                @if (t.representante) {
                  {{ t.representante }}
                } @else {
                  <span class="text-muted">Sin designar</span>
                }
              </td>
              <td data-label="Día">{{ t.dia }}</td>
              <td data-label="Horario">
                <span class="time-range"
                  >{{ t.horaInicio }}<i class="ri-arrow-right-line" aria-hidden="true"></i
                  >{{ t.horaFin }}</span
                >
              </td>
              <td class="cell-actions">
                <button
                  type="button"
                  class="icon-btn"
                  (click)="ver.emit(t)"
                  title="Ver detalle"
                  [attr.aria-label]="'Ver turno de ' + t.sector + ' el ' + t.dia"
                >
                  <i class="ri-eye-line" aria-hidden="true"></i>
                </button>
                <button
                  type="button"
                  class="icon-btn"
                  (click)="editar.emit(t)"
                  title="Editar"
                  [attr.aria-label]="'Editar turno de ' + t.sector"
                >
                  <i class="ri-edit-line" aria-hidden="true"></i>
                </button>
                <button
                  type="button"
                  class="icon-btn icon-btn--danger"
                  (click)="eliminar.emit(t)"
                  title="Eliminar"
                  [attr.aria-label]="'Eliminar turno de ' + t.sector"
                >
                  <i class="ri-delete-bin-line" aria-hidden="true"></i>
                </button>
              </td>
            </tr>
          }
        </tbody>
      </table>
    </div>
  `,
})
export class TurnosTablaComponent {
  readonly turnos = input.required<Turno[]>();
  readonly ver = output<Turno>();
  readonly editar = output<Turno>();
  readonly eliminar = output<Turno>();
}
