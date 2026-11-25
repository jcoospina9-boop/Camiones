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
    `Período: ${report.summary.startDate} al ${report.summary.endDate}  |  Jornada diaria: ${report.summary.dailyWorkHours}h  |  Trabajado Neto: ${report.summary.totalWorkedHours}h  |  Almuerzo: ${report.summary.totalLunchHours}h  |  Horas Extras: ${report.summary.totalOvertimeHours}h`,
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
      head: [['Vehículo', 'Placa', 'Jornadas', 'Visitas', 'Salidas', 'Horas Netas', 'Almuerzo', 'Horas Extras', 'Tiempo en Puntos']],
      body: report.byVehicle.map((v) => [
        v.label,
        v.sublabel,
        String(v.shiftsCount),
        String(v.visitsCount),
        String(v.exitsCount),
        formatMinutesAsHours(v.workedMinutes),
        formatMinutesAsHours(v.lunchMinutes),
        formatMinutesAsHours(v.overtimeMinutes),
        formatMinutesAsHours(v.stayMinutes),
      ]),
      styles: { fontSize: 8, cellPadding: 4.5 },
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
      head: [['Conductor', 'Usuario', 'Jornadas', 'Visitas', 'Horas Netas', 'Almuerzo', 'Horas Extras', 'Tiempo en Puntos']],
      body: report.byDriver.map((d) => [
        d.label,
        d.sublabel,
        String(d.shiftsCount),
        String(d.visitsCount),
        formatMinutesAsHours(d.workedMinutes),
        formatMinutesAsHours(d.lunchMinutes),
        formatMinutesAsHours(d.overtimeMinutes),
        formatMinutesAsHours(d.stayMinutes),
      ]),
      styles: { fontSize: 8, cellPadding: 4.5 },
      headStyles: { fillColor: [6, 95, 70] },
    });

    nextY = (doc as unknown as { lastAutoTable: { finalY: number } }).lastAutoTable.finalY + 24;
  }

  if (report.shifts.length > 0) {
    doc.addPage();
    doc.setFontSize(12);
    doc.setTextColor(15, 23, 42);
    doc.text(`Jornadas y Horas Extras (Meta diaria: ${report.summary.dailyWorkHours}h)`, 40, 42);

    autoTable(doc, {
      startY: 52,
      head: [['Conductor', 'Vehículo', 'Inicio', 'Fin', 'Almuerzo', 'Trabajado Neto', 'Horas Extras']],
      body: report.shifts.map((sh) => [
        sh.driverCode ? `${sh.driverName} (${sh.driverCode})` : sh.driverName,
        `${sh.vehicleCode} (${sh.vehiclePlate})`,
        sh.startTime,
        sh.endTime ?? 'En curso',
        formatMinutesAsHours(sh.lunchMinutes),
        formatMinutesAsHours(sh.workedMinutes),
        formatMinutesAsHours(sh.overtimeMinutes),
      ]),
      styles: { fontSize: 8, cellPadding: 4 },
      headStyles: { fillColor: [6, 78, 59] },
    });
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
    { Indicador: 'Jornada Diaria Configurada (h)', Valor: report.summary.dailyWorkHours },
    { Indicador: 'Total Eventos', Valor: report.summary.totalEvents },
    { Indicador: 'Total Visitas (Entradas)', Valor: report.summary.totalVisits },
    { Indicador: 'Total Jornadas Iniciadas', Valor: report.summary.totalShifts },
    { Indicador: 'Total Horas Trabajadas (Netas)', Valor: report.summary.totalWorkedHours },
    { Indicador: 'Total Horas de Almuerzo', Valor: report.summary.totalLunchHours },
    { Indicador: 'Total Horas Extras', Valor: report.summary.totalOvertimeHours },
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
    'Minutos Trabajados (Netos)': v.workedMinutes,
    'Horas Netas': formatMinutesAsHours(v.workedMinutes),
    'Almuerzo (min)': v.lunchMinutes,
    'Horas Almuerzo': formatMinutesAsHours(v.lunchMinutes),
    'Horas Extras (min)': v.overtimeMinutes,
    'Horas Extras': formatMinutesAsHours(v.overtimeMinutes),
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
    'Horas Netas': formatMinutesAsHours(d.workedMinutes),
    'Almuerzo (min)': d.lunchMinutes,
    'Horas Almuerzo': formatMinutesAsHours(d.lunchMinutes),
    'Horas Extras (min)': d.overtimeMinutes,
    'Horas Extras': formatMinutesAsHours(d.overtimeMinutes),
    'Tiempo en Ubicaciones': formatMinutesAsHours(d.stayMinutes),
  }));
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(driverRows), 'Por Conductor');

  const shiftRows = report.shifts.map((sh) => ({
    Fecha: sh.date,
    Conductor: sh.driverName,
    Código: sh.driverCode,
    Vehículo: sh.vehicleCode,
    Placa: sh.vehiclePlate,
    Inicio: sh.startTime,
    Fin: sh.endTime ?? 'En curso',
    'Almuerzo (min)': sh.lunchMinutes,
    Almuerzo: formatMinutesAsHours(sh.lunchMinutes),
    'Trabajado Neto (min)': sh.workedMinutes ?? '',
    'Trabajado Neto': formatMinutesAsHours(sh.workedMinutes),
    'Horas Extras (min)': sh.overtimeMinutes ?? '',
    'Horas Extras': formatMinutesAsHours(sh.overtimeMinutes),
  }));
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(shiftRows), 'Jornadas y Extras');

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
