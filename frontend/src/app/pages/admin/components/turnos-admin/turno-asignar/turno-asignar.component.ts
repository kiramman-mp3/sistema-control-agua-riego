import { Component, OnInit, inject, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { AdminService } from '../../../../../core/services/admin.service';
import { NotificationService } from '../../../../../core/services/notification.service';
import { SectorItem } from '../../../../../core/models/api-payloads';
import { errorHorarioTurno } from '../../../../../core/utils/turnos';
import { ModalComponent } from '../../../../../shared/ui/modal.component';
import { DIAS_SEMANA } from '../turno.model';
import { AYUDAS_FORMULARIO } from '../../../../../core/directives/formularios';

/**
 * Nuevo turno de riego: se elige el sector y el horario semanal (sin cruces dentro del sector).
 * El turno lo recibe el representante del sector, no cada usuario.
 */
@Component({
  selector: 'app-turno-asignar',
  standalone: true,
  imports: [FormsModule, ...AYUDAS_FORMULARIO, ModalComponent],
  templateUrl: './turno-asignar.component.html',
})
export class TurnoAsignarComponent implements OnInit {
  private admin = inject(AdminService);
  private notify = inject(NotificationService);

  readonly cerrar = output<void>();
  readonly asignado = output<void>();

  readonly dias = DIAS_SEMANA;
  readonly sectores = signal<SectorItem[]>([]);
  readonly cargandoSectores = signal(true);
  readonly guardando = signal(false);

  turno: {
    sector_id: number | null;
    dia_semana: number;
    hora_inicio: string;
    hora_fin: string;
    observacion: string;
  } = {
    sector_id: null,
    dia_semana: 1,
    hora_inicio: '08:00',
    hora_fin: '10:00',
    observacion: '',
  };

  ngOnInit(): void {
    this.admin.getSectores().subscribe({
      next: (res) => {
        this.sectores.set(res?.data ?? []);
        this.cargandoSectores.set(false);
      },
      error: () => {
        this.cargandoSectores.set(false);
        this.notify.error('No se pudieron cargar los sectores.');
      },
    });
  }

  guardar(): void {
    if (this.guardando()) return;
    const t = this.turno;
    if (!t.sector_id) return this.notify.warning('Debe seleccionar el sector.');
    if (!t.hora_inicio || !t.hora_fin)
      return this.notify.warning('Debe definir la hora de inicio y fin.');
    const errorHorario = errorHorarioTurno(t.hora_inicio, t.hora_fin);
    if (errorHorario) return this.notify.warning(errorHorario);

    this.guardando.set(true);
    this.admin.crearTurno(t).subscribe({
      next: (res) => {
        this.guardando.set(false);
        this.notify.success(res.message || 'Turno de agua creado.');
        this.asignado.emit();
      },
      error: (err) => {
        this.guardando.set(false);
        this.notify.error(err.error?.message || 'Error al crear el turno.');
      },
    });
  }
}
