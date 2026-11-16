import { Component, computed, inject, input, output } from '@angular/core';
import { ModalComponent } from '../../../../../shared/ui/modal.component';
import { LotesMapComponent } from '../../lotes-map/lotes-map.component';
import { LoteItem } from '../../../../../core/models/api-payloads';
import { textoSuperficie } from '../../../../../core/utils/superficie';
import { AdminService } from '../../../../../core/services/admin.service';
import { DialogService } from '../../../../../core/services/dialog.service';
import { NotificationService } from '../../../../../core/services/notification.service';

/** Ficha de un lote: datos del catastro, propietarios vinculados y georreferenciación. */
@Component({
  selector: 'app-lote-detalle',
  standalone: true,
  imports: [ModalComponent, LotesMapComponent],
  template: `
    @let l = lote();
    <app-modal
      [titulo]="'Lote ' + l.codigo"
      [subtitulo]="l.sector_nombre"
      icono="ri-map-pin-2-line"
      tamano="md"
      (cerrar)="cerrar.emit()"
    >
      <div class="modal__body form-stack">
        <dl class="fact-grid">
          <div>
            <dt>Código</dt>
            <dd class="fact-grid__big">{{ l.codigo }}</dd>
          </div>
          <div>
            <dt>Sector</dt>
            <dd>{{ l.sector_nombre }}</dd>
          </div>
          <div>
            <dt>Superficie</dt>
            <dd>{{ textoSuperficie(l.superficie_m2) }}</dd>
          </div>
        </dl>

        <section class="detail-section">
          <h4 class="detail-section__title">
            <i class="ri-user-star-line" aria-hidden="true"></i> Titular
          </h4>
          @if (l.propietario_nombre || propietarios().length) {
            <div class="ownership">
              <span class="ownership__value">100 %</span>
              <span class="ownership__text">
                <strong>{{ l.propietario_nombre || propietarios()[0] }}</strong>
                {{ l.tipo_relacion === 'REPRESENTANTE' ? 'Representante' : 'Propietario titular'
                }}{{ l.propietario_cedula ? ' · C.I. ' + l.propietario_cedula : '' }}
              </span>
            </div>
          } @else {
            <p class="text-muted small">El lote no tiene titular asignado ("Sin dueño").</p>
          }
        </section>

        <section class="detail-section">
          <h4 class="detail-section__title">
            <i class="ri-map-2-line" aria-hidden="true"></i> Georreferenciación
          </h4>
          @if (tieneUbicacion()) {
            <app-lotes-map
              [latitud]="lat()"
              [longitud]="lng()"
              [radioError]="l.radio_error_m || 5"
              [alto]="240"
            />
          }
          <dl class="kv-list">
            <div>
              <dt>Coordenadas</dt>
              <dd class="money">
                {{ l.latitud_aproximada || 'N/D' }}, {{ l.longitud_aproximada || 'N/D' }}
              </dd>
            </div>
            <div>
              <dt>Margen de error</dt>
              <dd>±{{ l.radio_error_m || 5 }} m</dd>
            </div>
            <div>
              <dt>Referencia</dt>
              <dd>{{ l.referencia_ubicacion || 'Sin referencia' }}</dd>
            </div>
          </dl>
        </section>

        @if (l.observacion) {
          <section class="detail-section">
            <h4 class="detail-section__title">
              <i class="ri-file-text-line" aria-hidden="true"></i> Observaciones
            </h4>
            <p class="prewrap">{{ l.observacion }}</p>
          </section>
        }
      </div>
      <div class="modal__footer">
        @if (tieneUbicacion()) {
          <button type="button" class="btn btn--ghost" (click)="abrirGoogleMaps()">
            <i class="ri-google-fill" aria-hidden="true"></i> Ver en Google Maps
          </button>
        }
        <button type="button" class="btn btn--outline" (click)="editar.emit(l)">
          <i class="ri-edit-line" aria-hidden="true"></i> Editar lote
        </button>
        <button type="button" class="btn btn--danger" (click)="eliminar()">
          <i class="ri-delete-bin-line" aria-hidden="true"></i> Eliminar lote
        </button>
        <button type="button" class="btn btn--primary" (click)="cerrar.emit()">Cerrar</button>
      </div>
    </app-modal>
  `,
})
export class LoteDetalleComponent {
  readonly textoSuperficie = textoSuperficie;
  readonly lote = input.required<LoteItem>();
  readonly cerrar = output<void>();
  readonly editar = output<LoteItem>();
  readonly eliminado = output<void>();

  private admin = inject(AdminService);
  private dialog = inject(DialogService);
  private notify = inject(NotificationService);

  readonly propietarios = computed<string[]>(() =>
    this.lote().propietarios ? String(this.lote().propietarios).split(', ') : [],
  );
  readonly lat = computed(() => parseFloat(String(this.lote().latitud_aproximada ?? '')));
  readonly lng = computed(() => parseFloat(String(this.lote().longitud_aproximada ?? '')));
  readonly tieneUbicacion = computed(() => !Number.isNaN(this.lat()) && !Number.isNaN(this.lng()));

  abrirGoogleMaps(): void {
    window.open(`https://www.google.com/maps?q=${this.lat()},${this.lng()}&t=k`, '_blank');
  }

  /** Borra un lote registrado por error; el servidor lo rechaza si ya tiene cuotas anuales de agua. */
  async eliminar(): Promise<void> {
    const l = this.lote();
    const confirmado = await this.dialog.confirmar({
      tipo: 'DANGER',
      titulo: 'Eliminar lote',
      mensaje: `¿Eliminar el lote ${l.codigo}? Úselo solo si se registró por error: se pierde también su vínculo con el titular y no se puede deshacer. Si el lote ya tiene cuotas de agua, el sistema no lo permitirá.`,
      textoConfirmar: 'Eliminar',
    });
    if (!confirmado) return;
    this.admin.deleteLote(l.id).subscribe({
      next: (res) => {
        this.notify.success(res.message || 'Lote eliminado.');
        this.eliminado.emit();
      },
      error: (err) => this.notify.error(err.error?.message || 'No se pudo eliminar el lote.'),
    });
  }
}
