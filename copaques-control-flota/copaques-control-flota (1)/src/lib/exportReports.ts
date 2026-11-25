import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';
import * as XLSX from 'xlsx';
import {
  formatEventLabel,
  formatMinutesAsHours,
  type ReportResponse,
} from '../types.ts';

export function exportReportToPDF(report: ReportResponse): void {
  const doc = new jsPDF({ orientation: 'landscape', unit: 'pt', format: 'letter' });

  doc.setFontSize(16);
  doc.setTextColor(15, 23, 42);
  doc.text('Copaques — Reporte Operativo de Flota', 40, 42);

  doc.setFontSize(10);
  doc.setTextColor(71, 85, 105);
  doc.text(
    `Período: ${report.summary.startDate} al ${report.summary.endDate}  |  Eventos: ${report.summary.totalEvents}  |  Visitas (Entradas): ${report.summary.totalVisits}  |  Horas Trabajadas: ${report.summary.totalWorkedHours}h`,
    40,
    60
  );

  let nextY = 80;

  if (report.byVehicle.length > 0) {
    doc.setFontSize(12);
    doc.setTextColor(15, 23, 42);
    doc.text('Resumen por Vehículo', 40, nextY);

    autoTable(doc, {
      startY: nextY + 8,
      head: [['Vehículo', 'Placa', 'Jornadas', 'Visitas', 'Salidas', 'Eventos', 'Horas Trabajadas', 'Tiempo en Puntos']],
      body: report.byVehicle.map((v) => [
        v.label,
        v.sublabel,
        String(v.shiftsCount),
        String(v.visitsCount),
        String(v.exitsCount),
        String(v.totalEvents),
        formatMinutesAsHours(v.workedMinutes),
        formatMinutesAsHours(v.stayMinutes),
      ]),
      styles: { fontSize: 8.5, cellPadding: 5 },
      headStyles: { fillColor: [6, 78, 59] },
    });

    nextY = (doc as unknown as { lastAutoTable: { finalY: number } }).lastAutoTable.finalY + 24;
  }

  if (report.byDriver.length > 0) {
    doc.setFontSize(12);
    doc.setTextColor(15, 23, 42);
    doc.text('Resumen por Conductor', 40, nextY);

    autoTable(doc, {
      startY: nextY + 8,
      head: [['Conductor', 'Usuario', 'Jornadas', 'Visitas', 'Eventos', 'Horas Trabajadas', 'Tiempo en Puntos']],
      body: report.byDriver.map((d) => [
        d.label,
        d.sublabel,
        String(d.shiftsCount),
        String(d.visitsCount),
        String(d.totalEvents),
        formatMinutesAsHours(d.workedMinutes),
        formatMinutesAsHours(d.stayMinutes),
      ]),
      styles: { fontSize: 8.5, cellPadding: 5 },
      headStyles: { fillColor: [6, 95, 70] },
    });

    nextY = (doc as unknown as { lastAutoTable: { finalY: number } }).lastAutoTable.finalY + 24;
  }

  if (report.locationStays.length > 0) {
    doc.addPage();
    doc.setFontSize(12);
    doc.setTextColor(15, 23, 42);
    doc.text('Permanencia por Ubicación (Entradas y Salidas)', 40, 42);

    autoTable(doc, {
      startY: 52,
      head: [['Vehículo', 'Conductor', 'Ubicación / Geocerca', 'Entrada', 'Salida', 'Duración']],
      body: report.locationStays.map((s) => [
        `${s.vehicleCode} (${s.vehiclePlate})`,
        s.driverName,
        s.locationName,
        s.entryTime,
        s.exitTime ?? 'En curso',
        formatMinutesAsHours(s.durationMinutes),
      ]),
      styles: { fontSize: 8, cellPadding: 4 },
      headStyles: { fillColor: [6, 78, 59] },
    });
  }

  if (report.events.length > 0) {
    doc.addPage();
    doc.setFontSize(12);
    doc.setTextColor(15, 23, 42);
    doc.text('Detalle Cronológico de Eventos', 40, 42);

    autoTable(doc, {
      startY: 52,
      head: [['Fecha', 'Hora', 'Vehículo', 'Conductor', 'Evento', 'Origen', 'Dirección', 'Observaciones']],
      body: report.events.map((e) => [
        e.event_date,
        e.event_time,
        `${e.vehicle_code_snapshot} (${e.vehicle_plate_snapshot})`,
        e.driver_name_snapshot,
        formatEventLabel(e.event_type),
        e.source === 'GEOCERCA_AUTO' ? 'Geocerca Auto' : 'Manual',
        e.address,
        e.notes || '-',
      ]),
      styles: { fontSize: 7.5, cellPadding: 4 },
      headStyles: { fillColor: [6, 78, 59] },
    });
  }

  doc.save(`copaques_reporte_flota_${report.summary.startDate}_${report.summary.endDate}.pdf`);
}

export function exportReportToExcel(report: ReportResponse): void {
  const wb = XLSX.utils.book_new();

  const summaryRows = [
    { Indicador: 'Fecha Inicio', Valor: report.summary.startDate },
    { Indicador: 'Fecha Fin', Valor: report.summary.endDate },
    { Indicador: 'Total Eventos', Valor: report.summary.totalEvents },
    { Indicador: 'Total Visitas (Entradas)', Valor: report.summary.totalVisits },
    { Indicador: 'Total Jornadas Iniciadas', Valor: report.summary.totalShifts },
    { Indicador: 'Total Horas Trabajadas', Valor: report.summary.totalWorkedHours },
    { Indicador: 'Total Horas en Ubicaciones', Valor: report.summary.totalStayHours },
  ];
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(summaryRows), 'Resumen');

  const vehicleRows = report.byVehicle.map((v) => ({
    Vehículo: v.label,
    Placa: v.sublabel,
    Jornadas: v.shiftsCount,
    Visitas: v.visitsCount,
    Salidas: v.exitsCount,
    Eventos: v.totalEvents,
    'Minutos Trabajados': v.workedMinutes,
    'Horas Trabajadas': formatMinutesAsHours(v.workedMinutes),
    'Tiempo en Ubicaciones': formatMinutesAsHours(v.stayMinutes),
  }));
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(vehicleRows), 'Por Vehiculo');

  const driverRows = report.byDriver.map((d) => ({
    Conductor: d.label,
    Usuario: d.sublabel,
    Jornadas: d.shiftsCount,
    Visitas: d.visitsCount,
    Salidas: d.exitsCount,
    Eventos: d.totalEvents,
    'Horas Trabajadas': formatMinutesAsHours(d.workedMinutes),
    'Tiempo en Ubicaciones': formatMinutesAsHours(d.stayMinutes),
  }));
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(driverRows), 'Por Conductor');

  const stayRows = report.locationStays.map((s) => ({
    Fecha: s.date,
    Vehículo: s.vehicleCode,
    Placa: s.vehiclePlate,
    Conductor: s.driverName,
    Ubicación: s.locationName,
    Entrada: s.entryTime,
    Salida: s.exitTime ?? 'En curso',
    'Duración (min)': s.durationMinutes ?? '',
    Duración: formatMinutesAsHours(s.durationMinutes),
  }));
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(stayRows), 'Permanencia');

  const eventRows = report.events.map((e) => ({
    ID: e.event_uuid,
    Fecha: e.event_date,
    Hora: e.event_time,
    Vehículo: e.vehicle_code_snapshot,
    Placa: e.vehicle_plate_snapshot,
    Conductor: e.driver_name_snapshot,
    Usuario: e.username_snapshot,
    Evento: formatEventLabel(e.event_type),
    Origen: e.source === 'GEOCERCA_AUTO' ? 'Geocerca Automática' : 'Manual',
    Geocerca: e.geofence_name_snapshot ?? '',
    Latitud: e.latitude,
    Longitud: e.longitude,
    Dirección: e.address,
    Observaciones: e.notes,
  }));
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(eventRows), 'Eventos');

  XLSX.writeFile(
    wb,
    `copaques_reporte_flota_${report.summary.startDate}_${report.summary.endDate}.xlsx`
  );
}
