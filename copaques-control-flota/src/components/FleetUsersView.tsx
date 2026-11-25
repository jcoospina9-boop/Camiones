import { useEffect, useMemo, useState, type FormEvent } from 'react';
import {
  ArrowRightLeft,
  Building2,
  ChevronLeft,
  ChevronRight,
  Edit2,
  Plus,
  Power,
  Search,
  Shield,
  Trash2,
  Truck,
  Users as UsersIcon,
} from 'lucide-react';
import { apiFetch } from '../lib/api.ts';
import {
  formatRoleLabel,
  getDocExpiryStatus,
  type Sede,
  type User,
  type UserRole,
  type Vehicle,
} from '../types.ts';

interface FleetUsersViewProps {
  userRole: UserRole;
  userSedeId: number | null;
  sedes: Sede[];
  selectedSedeId: number | null;
  onSelectSede: (sedeId: number | null) => void;
  vehicles: Vehicle[];
  users: User[];
  onRefresh: () => Promise<void>;
}

const PAGE_SIZE = 12;

export function FleetUsersView({
  userRole,
  userSedeId,
  sedes,
  selectedSedeId,
  onSelectSede,
  vehicles,
  users,
  onRefresh,
}: FleetUsersViewProps) {
  const isGerencia = userRole === 'GERENCIA';
  const [subTab, setSubTab] = useState<'vehicles' | 'admins' | 'drivers'>(
    isGerencia ? 'vehicles' : 'drivers'
  );
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const [allSedes, setAllSedes] = useState<Sede[]>(sedes);

  // Vehicle form state (GERENCIA ONLY)
  const [editingVehicleId, setEditingVehicleId] = useState<number | null>(null);
  const [vCode, setVCode] = useState('');
  const [vPlate, setVPlate] = useState('');
  const [vBrand, setVBrand] = useState('');
  const [vModel, setVModel] = useState('');
  const [vCapacity, setVCapacity] = useState('');
  const [vSoatExpires, setVSoatExpires] = useState('');
  const [vTecnoExpires, setVTecnoExpires] = useState('');
  const [vSedeId, setVSedeId] = useState<string>(
    selectedSedeId ? String(selectedSedeId) : sedes[0] ? String(sedes[0].id) : ''
  );

  // Vehicle sede transfer modal state
  const [transferVehicle, setTransferVehicle] = useState<Vehicle | null>(null);
  const [transferTargetSedeId, setTransferTargetSedeId] = useState<string>('');
  const [transferring, setTransferring] = useState(false);

  // User form state
  const [editingUserId, setEditingUserId] = useState<number | null>(null);
  const [uUsername, setUUsername] = useState('');
  const [uFullName, setUFullName] = useState('');
  const [uDriverCode, setUDriverCode] = useState('');
  const [uPassword, setUPassword] = useState('');
  const [uRole, setURole] = useState<UserRole>(isGerencia ? 'ADMIN' : 'CONDUCTOR');
  const [uSedeId, setUSedeId] = useState<string>(
    selectedSedeId ? String(selectedSedeId) : sedes[0] ? String(sedes[0].id) : ''
  );
  const [uVehicleId, setUVehicleId] = useState<string>('');

  // Driver delete confirmation state
  const [deletingUser, setDeletingUser] = useState<User | null>(null);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    setPage(1);
  }, [subTab, search, selectedSedeId]);

  useEffect(() => {
    apiFetch<{ sedes: Sede[] }>('/api/admin/sedes?all=1')
      .then((res) => setAllSedes(res.sedes))
      .catch(() => setAllSedes(sedes));
  }, [sedes]);

  useEffect(() => {
    if (!editingVehicleId && selectedSedeId) {
      setVSedeId(String(selectedSedeId));
    } else if (!vSedeId && sedes[0]) {
      setVSedeId(String(sedes[0].id));
    }
  }, [selectedSedeId, sedes, editingVehicleId, vSedeId]);

  useEffect(() => {
    if (!editingUserId && selectedSedeId) {
      setUSedeId(String(selectedSedeId));
    } else if (!uSedeId && sedes[0]) {
      setUSedeId(String(sedes[0].id));
    }
  }, [selectedSedeId, sedes, editingUserId, uSedeId]);

  function resetVehicleForm() {
    setEditingVehicleId(null);
    setVCode('');
    setVPlate('');
    setVBrand('');
    setVModel('');
    setVCapacity('');
    setVSoatExpires('');
    setVTecnoExpires('');
    setVSedeId(selectedSedeId ? String(selectedSedeId) : sedes[0] ? String(sedes[0].id) : '');
  }

  function startEditVehicle(v: Vehicle) {
    setEditingVehicleId(v.id);
    setVCode(v.code);
    setVPlate(v.plate);
    setVBrand(v.brand);
    setVModel(v.model);
    setVCapacity(v.capacity_tons ? String(v.capacity_tons) : '');
    setVSoatExpires(v.soat_expires_at || '');
    setVTecnoExpires(v.tecnomecanica_expires_at || '');
    setVSedeId(v.sede_id ? String(v.sede_id) : sedes[0] ? String(sedes[0].id) : '');
  }

  async function handleSaveVehicle(e: FormEvent) {
    e.preventDefault();
    if (!isGerencia) return;
    setError(null);
    setSaving(true);
    try {
      const payload = {
        code: vCode,
        plate: vPlate,
        brand: vBrand,
        model: vModel,
        capacity_tons: Number(vCapacity) || 0,
        soat_expires_at: vSoatExpires,
        tecnomecanica_expires_at: vTecnoExpires,
        sede_id: Number(vSedeId),
      };
      if (editingVehicleId) {
        await apiFetch(`/api/admin/vehicles/${editingVehicleId}`, {
          method: 'PUT',
          body: JSON.stringify(payload),
        });
      } else {
        await apiFetch('/api/admin/vehicles', {
          method: 'POST',
          body: JSON.stringify(payload),
        });
      }
      resetVehicleForm();
      await onRefresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error al guardar vehículo.');
    } finally {
      setSaving(false);
    }
  }

  async function toggleVehicleActive(v: Vehicle) {
    if (!isGerencia) return;
    setError(null);
    try {
      await apiFetch(`/api/admin/vehicles/${v.id}`, {
        method: 'PUT',
        body: JSON.stringify({ active: v.active === 1 ? false : true }),
      });
      await onRefresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error al actualizar vehículo.');
    }
  }

  function openTransferModal(v: Vehicle) {
    setError(null);
    setTransferVehicle(v);
    const firstOtherSede = allSedes.find((s) => s.id !== v.sede_id);
    setTransferTargetSedeId(firstOtherSede ? String(firstOtherSede.id) : '');
  }

  async function handleTransferSede(e: FormEvent) {
    e.preventDefault();
    if (!transferVehicle || !transferTargetSedeId) return;
    setError(null);
    setTransferring(true);
    try {
      await apiFetch(`/api/admin/vehicles/${transferVehicle.id}/transfer-sede`, {
        method: 'POST',
        body: JSON.stringify({ sede_id: Number(transferTargetSedeId) }),
      });
      setTransferVehicle(null);
      await onRefresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error al trasladar vehículo de sede.');
    } finally {
      setTransferring(false);
    }
  }

  function resetUserForm() {
    setEditingUserId(null);
    setUUsername('');
    setUFullName('');
    setUDriverCode('');
    setUPassword('');
    setURole(isGerencia ? 'ADMIN' : 'CONDUCTOR');
    setUSedeId(selectedSedeId ? String(selectedSedeId) : sedes[0] ? String(sedes[0].id) : '');
    setUVehicleId('');
  }

  function startEditUser(u: User) {
    setEditingUserId(u.id);
    setUUsername(u.username);
    setUFullName(u.full_name);
    setUDriverCode(u.driver_code || '');
    setUPassword('');
    setURole(u.role);
    setUSedeId(u.sede_id ? String(u.sede_id) : sedes[0] ? String(sedes[0].id) : '');
    setUVehicleId(u.vehicle_id ? String(u.vehicle_id) : '');
  }

  async function handleSaveUser(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSaving(true);
    try {
      const targetRole = isGerencia ? uRole : 'CONDUCTOR';
      if (editingUserId) {
        await apiFetch(`/api/admin/users/${editingUserId}`, {
          method: 'PUT',
          body: JSON.stringify({
            full_name: uFullName,
            driver_code: targetRole === 'CONDUCTOR' ? uDriverCode : undefined,
            role: targetRole,
            sede_id: targetRole === 'ADMIN' ? Number(uSedeId) : undefined,
            vehicle_id: targetRole === 'CONDUCTOR' && uVehicleId ? Number(uVehicleId) : null,
            password: uPassword || undefined,
          }),
        });
      } else {
        await apiFetch('/api/admin/users', {
          method: 'POST',
          body: JSON.stringify({
            username: uUsername,
            password: uPassword,
            full_name: uFullName,
            driver_code: targetRole === 'CONDUCTOR' ? uDriverCode : undefined,
            role: targetRole,
            sede_id: targetRole === 'ADMIN' ? Number(uSedeId) : userSedeId ?? undefined,
            vehicle_id: targetRole === 'CONDUCTOR' && uVehicleId ? Number(uVehicleId) : null,
          }),
        });
      }
      resetUserForm();
      await onRefresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error al guardar usuario.');
    } finally {
      setSaving(false);
    }
  }

  async function toggleUserActive(u: User) {
    setError(null);
    try {
      await apiFetch(`/api/admin/users/${u.id}`, {
        method: 'PUT',
        body: JSON.stringify({ active: u.active === 1 ? false : true }),
      });
      await onRefresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error al actualizar usuario.');
    }
  }

  async function handleConfirmDeleteUser() {
    if (!deletingUser) return;
    setError(null);
    setDeleting(true);
    try {
      await apiFetch(`/api/admin/users/${deletingUser.id}`, {
        method: 'DELETE',
      });
      if (editingUserId === deletingUser.id) {
        resetUserForm();
      }
      setDeletingUser(null);
      await onRefresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error al eliminar usuario.');
    } finally {
      setDeleting(false);
    }
  }

  const filteredVehicles = useMemo(() => {
    const q = search.trim().toLowerCase();
    return vehicles.filter((v) => {
      if (!q) return true;
      return (
        v.code.toLowerCase().includes(q) ||
        v.plate.toLowerCase().includes(q) ||
        v.brand.toLowerCase().includes(q) ||
        (v.sede_name || '').toLowerCase().includes(q) ||
        (v.assigned_driver_name || '').toLowerCase().includes(q)
      );
    });
  }, [vehicles, search]);

  const adminUsers = useMemo(
    () => users.filter((u) => u.role === 'ADMIN' || u.role === 'GERENCIA'),
    [users]
  );

  const driverUsers = useMemo(
    () => users.filter((u) => u.role === 'CONDUCTOR'),
    [users]
  );

  const filteredAdmins = useMemo(() => {
    const q = search.trim().toLowerCase();
    return adminUsers.filter((u) => {
      if (!q) return true;
      return (
        u.username.toLowerCase().includes(q) ||
        u.full_name.toLowerCase().includes(q) ||
        (u.sede_name || '').toLowerCase().includes(q)
      );
    });
  }, [adminUsers, search]);

  const filteredDrivers = useMemo(() => {
    const q = search.trim().toLowerCase();
    return driverUsers.filter((u) => {
      if (!q) return true;
      return (
        u.username.toLowerCase().includes(q) ||
        u.full_name.toLowerCase().includes(q) ||
        (u.driver_code || '').toLowerCase().includes(q) ||
        (u.sede_name || '').toLowerCase().includes(q) ||
        (u.vehicle_code || '').toLowerCase().includes(q) ||
        (u.vehicle_plate || '').toLowerCase().includes(q)
      );
    });
  }, [driverUsers, search]);

  const activeListLength =
    subTab === 'vehicles'
      ? filteredVehicles.length
      : subTab === 'admins'
        ? filteredAdmins.length
        : filteredDrivers.length;
  const totalPages = Math.max(1, Math.ceil(activeListLength / PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  const pageVehicles = filteredVehicles.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);
  const pageAdmins = filteredAdmins.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);
  const pageDrivers = filteredDrivers.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);

  return (
    <div className="space-y-5">
      {/* Gerencia Sede Filter Bar to prevent 40-truck clutter */}
      {isGerencia && sedes.length > 0 && (
        <div className="bg-white border border-slate-200 rounded-xl p-3 flex flex-wrap items-center gap-2">
          <span className="text-xs font-semibold text-slate-600 flex items-center gap-1.5 mr-1">
            <Building2 className="w-4 h-4 text-emerald-700" />
            <span>Sede:</span>
          </span>
          <button
            type="button"
            onClick={() => onSelectSede(null)}
            className={`px-3 py-1.5 rounded-lg text-xs font-semibold cursor-pointer transition-colors ${
              selectedSedeId === null
                ? 'bg-emerald-800 text-white'
                : 'bg-slate-100 text-slate-700 hover:bg-slate-200'
            }`}
          >
            Todas
          </button>
          {sedes.map((s) => (
            <button
              key={s.id}
              type="button"
              onClick={() => onSelectSede(s.id)}
              className={`px-3 py-1.5 rounded-lg text-xs font-semibold cursor-pointer transition-colors ${
                selectedSedeId === s.id
                  ? 'bg-emerald-800 text-white'
                  : 'bg-slate-100 text-slate-700 hover:bg-slate-200'
              }`}
            >
              {s.name}
            </button>
          ))}
        </div>
      )}

      {/* Sub-navigation + Search */}
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-1 p-1 bg-slate-200/70 rounded-lg overflow-x-auto">
          {isGerencia && (
            <>
              <button
                type="button"
                onClick={() => setSubTab('vehicles')}
                className={`px-4 py-1.5 rounded-md text-xs font-semibold flex items-center gap-2 cursor-pointer transition-colors whitespace-nowrap shrink-0 ${
                  subTab === 'vehicles'
                    ? 'bg-white text-slate-900 shadow-xs'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                <Truck className="w-4 h-4" />
                <span>Camiones ({vehicles.length})</span>
              </button>
              <button
                type="button"
                onClick={() => setSubTab('admins')}
                className={`px-4 py-1.5 rounded-md text-xs font-semibold flex items-center gap-2 cursor-pointer transition-colors whitespace-nowrap shrink-0 ${
                  subTab === 'admins'
                    ? 'bg-white text-slate-900 shadow-xs'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                <Shield className="w-4 h-4" />
                <span>Administradores ({adminUsers.length})</span>
              </button>
              <button
                type="button"
                onClick={() => setSubTab('drivers')}
                className={`px-4 py-1.5 rounded-md text-xs font-semibold flex items-center gap-2 cursor-pointer transition-colors whitespace-nowrap shrink-0 ${
                  subTab === 'drivers'
                    ? 'bg-white text-slate-900 shadow-xs'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                <UsersIcon className="w-4 h-4" />
                <span>Conductores ({driverUsers.length})</span>
              </button>
            </>
          )}

          {!isGerencia && (
            <>
              <button
                type="button"
                onClick={() => setSubTab('drivers')}
                className={`px-4 py-1.5 rounded-md text-xs font-semibold flex items-center gap-2 cursor-pointer transition-colors whitespace-nowrap shrink-0 ${
                  subTab === 'drivers'
                    ? 'bg-white text-slate-900 shadow-xs'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                <UsersIcon className="w-4 h-4" />
                <span>Conductores de la Sede ({driverUsers.length})</span>
              </button>
              <button
                type="button"
                onClick={() => setSubTab('vehicles')}
                className={`px-4 py-1.5 rounded-md text-xs font-semibold flex items-center gap-2 cursor-pointer transition-colors whitespace-nowrap shrink-0 ${
                  subTab === 'vehicles'
                    ? 'bg-white text-slate-900 shadow-xs'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                <Truck className="w-4 h-4" />
                <span>Camiones Asignados ({vehicles.length})</span>
              </button>
            </>
          )}
        </div>

        <div className="relative w-full sm:w-72">
          <Search className="w-4 h-4 text-slate-400 absolute left-3 top-2.5" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Buscar código, placa, nombre..."
            className="w-full h-9 pl-9 pr-3 rounded-lg border border-slate-300 bg-white text-sm focus:outline-none focus:ring-2 focus:ring-emerald-700"
          />
        </div>
      </div>

      {error && (
        <div className="p-3 rounded-lg bg-red-50 border border-red-200 text-sm text-red-700">
          {error}
        </div>
      )}

      {/* VEHICLES TAB */}
      {subTab === 'vehicles' && (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-5 items-start">
          {isGerencia && (
            <div className="lg:col-span-4 bg-white border border-slate-200 rounded-xl p-5">
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-base font-bold text-slate-900">
                  {editingVehicleId ? 'Editar Camión' : 'Registrar Camión'}
                </h3>
                {editingVehicleId && (
                  <button
                    type="button"
                    onClick={resetVehicleForm}
                    className="text-xs font-medium text-slate-600 hover:text-slate-900 cursor-pointer"
                  >
                    Cancelar
                  </button>
                )}
              </div>

              <form onSubmit={handleSaveVehicle} className="space-y-3">
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    Sede asignada
                  </label>
                  <select
                    required
                    value={vSedeId}
                    onChange={(e) => setVSedeId(e.target.value)}
                    className="w-full h-10 px-3 rounded-lg border border-slate-300 text-sm bg-white"
                  >
                    <option value="">Selecciona una sede...</option>
                    {sedes.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs font-medium text-slate-700 mb-1">
                      Código interno
                    </label>
                    <input
                      type="text"
                      required
                      value={vCode}
                      onChange={(e) => setVCode(e.target.value)}
                      placeholder="CAM-01"
                      className="w-full h-10 px-3 rounded-lg border border-slate-300 text-sm uppercase font-mono"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-slate-700 mb-1">Placa</label>
                    <input
                      type="text"
                      required
                      value={vPlate}
                      onChange={(e) => setVPlate(e.target.value)}
                      placeholder="ABC-123"
                      className="w-full h-10 px-3 rounded-lg border border-slate-300 text-sm uppercase font-mono"
                    />
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs font-medium text-slate-700 mb-1">Marca</label>
                    <input
                      type="text"
                      value={vBrand}
                      onChange={(e) => setVBrand(e.target.value)}
                      placeholder="Kenworth / Hino"
                      className="w-full h-10 px-3 rounded-lg border border-slate-300 text-sm"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-slate-700 mb-1">Modelo / Año</label>
                    <input
                      type="text"
                      value={vModel}
                      onChange={(e) => setVModel(e.target.value)}
                      placeholder="2023"
                      className="w-full h-10 px-3 rounded-lg border border-slate-300 text-sm"
                    />
                  </div>
                </div>

                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    Capacidad (toneladas)
                  </label>
                  <input
                    type="number"
                    step="0.5"
                    min="0"
                    value={vCapacity}
                    onChange={(e) => setVCapacity(e.target.value)}
                    placeholder="12"
                    className="w-full h-10 px-3 rounded-lg border border-slate-300 text-sm font-mono tabular-nums"
                  />
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs font-medium text-slate-700 mb-1">
                      Vence SOAT
                    </label>
                    <input
                      type="date"
                      value={vSoatExpires}
                      onChange={(e) => setVSoatExpires(e.target.value)}
                      className="w-full h-10 px-2.5 rounded-lg border border-slate-300 text-xs font-mono"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-slate-700 mb-1">
                      Vence Tecnomecánica
                    </label>
                    <input
                      type="date"
                      value={vTecnoExpires}
                      onChange={(e) => setVTecnoExpires(e.target.value)}
                      className="w-full h-10 px-2.5 rounded-lg border border-slate-300 text-xs font-mono"
                    />
                  </div>
                </div>

                <button
                  type="submit"
                  disabled={saving}
                  className="w-full h-11 rounded-lg bg-emerald-800 hover:bg-emerald-900 text-white text-sm font-semibold flex items-center justify-center gap-2 cursor-pointer disabled:opacity-60"
                >
                  <Plus className="w-4 h-4" />
                  <span>{saving ? 'Guardando...' : editingVehicleId ? 'Actualizar Camión' : 'Agregar Camión'}</span>
                </button>
              </form>
            </div>
          )}

          <div
            className={`${
              isGerencia ? 'lg:col-span-8' : 'lg:col-span-12'
            } bg-white border border-slate-200 rounded-xl overflow-hidden`}
          >
            {!isGerencia && (
              <div className="px-5 py-3 bg-emerald-50 border-b border-emerald-200 text-xs text-emerald-900">
                Los camiones de tu sede son registrados por Gerencia. Puedes revisar sus vencimientos de SOAT/Tecnomecánica o trasladar un camión disponible a otra sede.
              </div>
            )}
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse text-sm">
                <thead>
                  <tr className="bg-slate-50 border-b border-slate-200 text-xs font-semibold text-slate-600">
                    <th className="py-2.5 px-4">Código</th>
                    <th className="py-2.5 px-4">Placa</th>
                    <th className="py-2.5 px-4">Sede</th>
                    <th className="py-2.5 px-4">Vehículo</th>
                    <th className="py-2.5 px-4 text-right">Cap.</th>
                    <th className="py-2.5 px-4">SOAT / Tecno</th>
                    <th className="py-2.5 px-4">Base Fija</th>
                    <th className="py-2.5 px-4">Estado</th>
                    <th className="py-2.5 px-4 text-right">Acciones</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {pageVehicles.length === 0 ? (
                    <tr>
                      <td colSpan={9} className="py-8 text-center text-slate-500">
                        No hay camiones registrados en esta vista.
                      </td>
                    </tr>
                  ) : (
                    pageVehicles.map((v) => {
                      const soat = getDocExpiryStatus(v.soat_expires_at);
                      const tecno = getDocExpiryStatus(v.tecnomecanica_expires_at);
                      return (
                        <tr key={v.id} className="hover:bg-slate-50">
                          <td className="py-2.5 px-4 font-bold font-mono text-slate-900">{v.code}</td>
                          <td className="py-2.5 px-4 font-mono text-slate-700">{v.plate}</td>
                          <td className="py-2.5 px-4 text-xs font-semibold text-emerald-900">
                            {v.sede_name || 'Sin sede'}
                          </td>
                          <td className="py-2.5 px-4 text-slate-600">
                            {[v.brand, v.model].filter(Boolean).join(' ') || '-'}
                          </td>
                          <td className="py-2.5 px-4 text-right font-mono tabular-nums text-slate-700">
                            {v.capacity_tons > 0 ? `${v.capacity_tons} t` : '-'}
                          </td>
                          <td className="py-2.5 px-4 text-[11px] space-y-1 whitespace-nowrap">
                            <div>
                              <span className="font-semibold text-slate-500">SOAT: </span>
                              <span
                                className={`font-semibold ${
                                  soat.status === 'expired'
                                    ? 'text-red-700'
                                    : soat.status === 'soon'
                                      ? 'text-amber-700'
                                      : soat.status === 'ok'
                                        ? 'text-emerald-700'
                                        : 'text-slate-400'
                                }`}
                              >
                                {soat.label}
                              </span>
                            </div>
                            <div>
                              <span className="font-semibold text-slate-500">Tecno: </span>
                              <span
                                className={`font-semibold ${
                                  tecno.status === 'expired'
                                    ? 'text-red-700'
                                    : tecno.status === 'soon'
                                      ? 'text-amber-700'
                                      : tecno.status === 'ok'
                                        ? 'text-emerald-700'
                                        : 'text-slate-400'
                                }`}
                              >
                                {tecno.label}
                              </span>
                            </div>
                          </td>
                          <td className="py-2.5 px-4 text-slate-700 text-xs">
                            {v.assigned_driver_name ? (
                              <span>
                                {v.assigned_driver_name}{' '}
                                <span className="text-slate-400 font-mono">
                                  ({v.assigned_username})
                                </span>
                              </span>
                            ) : (
                              <span className="text-slate-400">Rotativo en sede</span>
                            )}
                          </td>
                          <td className="py-2.5 px-4">
                            <span
                              className={`text-xs font-semibold ${
                                v.active === 1 ? 'text-emerald-700' : 'text-slate-400'
                              }`}
                            >
                              {v.active === 1 ? 'Activo' : 'Inactivo'}
                            </span>
                          </td>
                          <td className="py-2.5 px-4 text-right">
                            <div className="inline-flex items-center gap-1">
                              <button
                                type="button"
                                onClick={() => openTransferModal(v)}
                                className="p-2 rounded-lg text-emerald-800 hover:bg-emerald-50 cursor-pointer"
                                title="Trasladar de sede"
                              >
                                <ArrowRightLeft className="w-4 h-4" />
                              </button>
                              {isGerencia && (
                                <>
                                  <button
                                    type="button"
                                    onClick={() => startEditVehicle(v)}
                                    className="p-2 rounded-lg text-slate-600 hover:bg-slate-100 cursor-pointer"
                                    title="Editar"
                                  >
                                    <Edit2 className="w-4 h-4" />
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => toggleVehicleActive(v)}
                                    className="p-2 rounded-lg text-slate-600 hover:bg-slate-100 cursor-pointer"
                                    title={v.active === 1 ? 'Desactivar' : 'Activar'}
                                  >
                                    <Power className="w-4 h-4" />
                                  </button>
                                </>
                              )}
                            </div>
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* ADMINS TAB (GERENCIA ONLY) */}
      {subTab === 'admins' && isGerencia && (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-5 items-start">
          <div className="lg:col-span-4 bg-white border border-slate-200 rounded-xl p-5">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-base font-bold text-slate-900">
                {editingUserId ? 'Editar Administrador' : 'Crear Administrador de Sede'}
              </h3>
              {editingUserId && (
                <button
                  type="button"
                  onClick={resetUserForm}
                  className="text-xs font-medium text-slate-600 hover:text-slate-900 cursor-pointer"
                >
                  Cancelar
                </button>
              )}
            </div>

            <form onSubmit={handleSaveUser} className="space-y-3">
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  Nombre completo
                </label>
                <input
                  type="text"
                  required
                  value={uFullName}
                  onChange={(e) => setUFullName(e.target.value)}
                  placeholder="Carlos Gómez"
                  className="w-full h-10 px-3 rounded-lg border border-slate-300 text-sm"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  Usuario de acceso
                </label>
                <input
                  type="text"
                  required
                  disabled={Boolean(editingUserId)}
                  value={uUsername}
                  onChange={(e) => setUUsername(e.target.value)}
                  placeholder="admin.rionegro"
                  className="w-full h-10 px-3 rounded-lg border border-slate-300 text-sm font-mono disabled:bg-slate-100"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  {editingUserId ? 'Nueva contraseña (opcional)' : 'Contraseña (mín. 6 caracteres)'}
                </label>
                <input
                  type="password"
                  required={!editingUserId}
                  minLength={editingUserId ? 0 : 6}
                  value={uPassword}
                  onChange={(e) => setUPassword(e.target.value)}
                  placeholder="••••••"
                  className="w-full h-10 px-3 rounded-lg border border-slate-300 text-sm"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">Rol</label>
                <select
                  value={uRole}
                  onChange={(e) => setURole(e.target.value as UserRole)}
                  className="w-full h-10 px-3 rounded-lg border border-slate-300 text-sm bg-white"
                >
                  <option value="ADMIN">Administrador de Sede (crea conductores)</option>
                  <option value="GERENCIA">Gerente General (todas las sedes)</option>
                </select>
              </div>

              {uRole === 'ADMIN' && (
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    Sede asignada
                  </label>
                  <select
                    required
                    value={uSedeId}
                    onChange={(e) => setUSedeId(e.target.value)}
                    className="w-full h-10 px-3 rounded-lg border border-slate-300 text-sm bg-white"
                  >
                    <option value="">Selecciona una sede...</option>
                    {sedes.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                      </option>
                    ))}
                  </select>
                </div>
              )}

              <button
                type="submit"
                disabled={saving}
                className="w-full h-11 rounded-lg bg-emerald-800 hover:bg-emerald-900 text-white text-sm font-semibold flex items-center justify-center gap-2 cursor-pointer disabled:opacity-60"
              >
                <Plus className="w-4 h-4" />
                <span>{saving ? 'Guardando...' : editingUserId ? 'Guardar Cambios' : 'Crear Administrador'}</span>
              </button>
            </form>
          </div>

          <div className="lg:col-span-8 bg-white border border-slate-200 rounded-xl overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse text-sm">
                <thead>
                  <tr className="bg-slate-50 border-b border-slate-200 text-xs font-semibold text-slate-600">
                    <th className="py-2.5 px-4">Nombre</th>
                    <th className="py-2.5 px-4">Usuario</th>
                    <th className="py-2.5 px-4">Rol</th>
                    <th className="py-2.5 px-4">Sede</th>
                    <th className="py-2.5 px-4">Estado</th>
                    <th className="py-2.5 px-4 text-right">Acciones</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {pageAdmins.map((u) => (
                    <tr key={u.id} className="hover:bg-slate-50">
                      <td className="py-2.5 px-4 font-semibold text-slate-900">{u.full_name}</td>
                      <td className="py-2.5 px-4 font-mono text-slate-700">{u.username}</td>
                      <td className="py-2.5 px-4 text-xs font-semibold text-slate-700">
                        {formatRoleLabel(u.role)}
                      </td>
                      <td className="py-2.5 px-4 text-xs font-semibold text-emerald-900">
                        {u.role === 'GERENCIA' ? 'Todas las sedes' : u.sede_name || '-'}
                      </td>
                      <td className="py-2.5 px-4">
                        <span
                          className={`text-xs font-semibold ${
                            u.active === 1 ? 'text-emerald-700' : 'text-slate-400'
                          }`}
                        >
                          {u.active === 1 ? 'Activo' : 'Inactivo'}
                        </span>
                      </td>
                      <td className="py-2.5 px-4 text-right">
                        <div className="inline-flex items-center gap-1">
                          <button
                            type="button"
                            onClick={() => startEditUser(u)}
                            className="p-2 rounded-lg text-slate-600 hover:bg-slate-100 cursor-pointer"
                            title="Editar"
                          >
                            <Edit2 className="w-4 h-4" />
                          </button>
                          <button
                            type="button"
                            onClick={() => toggleUserActive(u)}
                            className="p-2 rounded-lg text-slate-600 hover:bg-slate-100 cursor-pointer"
                            title={u.active === 1 ? 'Desactivar' : 'Activar'}
                          >
                            <Power className="w-4 h-4" />
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* DRIVERS TAB */}
      {subTab === 'drivers' && (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-5 items-start">
          {/* Only ADMIN creates drivers directly per hierarchy */}
          {!isGerencia && (
            <div className="lg:col-span-4 bg-white border border-slate-200 rounded-xl p-5">
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-base font-bold text-slate-900">
                  {editingUserId ? 'Editar Conductor' : 'Crear Conductor'}
                </h3>
                {editingUserId && (
                  <button
                    type="button"
                    onClick={resetUserForm}
                    className="text-xs font-medium text-slate-600 hover:text-slate-900 cursor-pointer"
                  >
                    Cancelar
                  </button>
                )}
              </div>

              <form onSubmit={handleSaveUser} className="space-y-3">
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    Nombre completo
                  </label>
                  <input
                    type="text"
                    required
                    value={uFullName}
                    onChange={(e) => setUFullName(e.target.value)}
                    placeholder="Juan Pérez"
                    className="w-full h-10 px-3 rounded-lg border border-slate-300 text-sm"
                  />
                </div>

                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    Código único del conductor
                  </label>
                  <input
                    type="text"
                    required
                    value={uDriverCode}
                    onChange={(e) => setUDriverCode(e.target.value.toUpperCase())}
                    placeholder="COND-01"
                    className="w-full h-10 px-3 rounded-lg border border-slate-300 text-sm uppercase font-mono"
                  />
                </div>

                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    Usuario de acceso
                  </label>
                  <input
                    type="text"
                    required
                    disabled={Boolean(editingUserId)}
                    value={uUsername}
                    onChange={(e) => setUUsername(e.target.value)}
                    placeholder="conductor01"
                    className="w-full h-10 px-3 rounded-lg border border-slate-300 text-sm font-mono disabled:bg-slate-100"
                  />
                </div>

                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    {editingUserId ? 'Nueva contraseña (opcional)' : 'Contraseña (mín. 6 caracteres)'}
                  </label>
                  <input
                    type="password"
                    required={!editingUserId}
                    minLength={editingUserId ? 0 : 6}
                    value={uPassword}
                    onChange={(e) => setUPassword(e.target.value)}
                    placeholder="••••••"
                    className="w-full h-10 px-3 rounded-lg border border-slate-300 text-sm"
                  />
                </div>

                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    Camión sugerido / fijo (opcional)
                  </label>
                  <select
                    value={uVehicleId}
                    onChange={(e) => setUVehicleId(e.target.value)}
                    className="w-full h-10 px-3 rounded-lg border border-slate-300 text-sm bg-white"
                  >
                    <option value="">Sin camión fijo (elige al iniciar jornada)</option>
                    {vehicles
                      .filter((v) => v.active === 1)
                      .map((v) => (
                        <option key={v.id} value={v.id}>
                          {v.code} · {v.plate}
                        </option>
                      ))}
                  </select>
                </div>

                <button
                  type="submit"
                  disabled={saving}
                  className="w-full h-11 rounded-lg bg-emerald-800 hover:bg-emerald-900 text-white text-sm font-semibold flex items-center justify-center gap-2 cursor-pointer disabled:opacity-60"
                >
                  <Plus className="w-4 h-4" />
                  <span>{saving ? 'Guardando...' : editingUserId ? 'Guardar Conductor' : 'Crear Conductor'}</span>
                </button>
              </form>
            </div>
          )}

          <div
            className={`${
              !isGerencia ? 'lg:col-span-8' : 'lg:col-span-12'
            } bg-white border border-slate-200 rounded-xl overflow-hidden`}
          >
            {isGerencia && (
              <div className="px-5 py-3 bg-slate-50 border-b border-slate-200 text-xs text-slate-600">
                Los conductores son creados por el <strong>Administrador de cada Sede</strong> con su código único y seleccionan su camión al iniciar jornada.
              </div>
            )}
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse text-sm">
                <thead>
                  <tr className="bg-slate-50 border-b border-slate-200 text-xs font-semibold text-slate-600">
                    <th className="py-2.5 px-4">Código</th>
                    <th className="py-2.5 px-4">Nombre</th>
                    <th className="py-2.5 px-4">Usuario</th>
                    <th className="py-2.5 px-4">Sede</th>
                    <th className="py-2.5 px-4">Camión Base</th>
                    <th className="py-2.5 px-4">Estado</th>
                    <th className="py-2.5 px-4 text-right">Acciones</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {pageDrivers.length === 0 ? (
                    <tr>
                      <td colSpan={7} className="py-8 text-center text-slate-500">
                        No hay conductores registrados en esta sede.
                      </td>
                    </tr>
                  ) : (
                    pageDrivers.map((u) => (
                      <tr key={u.id} className="hover:bg-slate-50">
                        <td className="py-2.5 px-4 font-bold font-mono text-emerald-900">
                          {u.driver_code || '-'}
                        </td>
                        <td className="py-2.5 px-4 font-semibold text-slate-900">{u.full_name}</td>
                        <td className="py-2.5 px-4 font-mono text-slate-700">{u.username}</td>
                        <td className="py-2.5 px-4 text-xs font-semibold text-emerald-900">
                          {u.sede_name || '-'}
                        </td>
                        <td className="py-2.5 px-4 font-mono text-xs text-slate-600">
                          {u.vehicle_code ? `${u.vehicle_code} · ${u.vehicle_plate}` : 'Elige al iniciar'}
                        </td>
                        <td className="py-2.5 px-4">
                          <span
                            className={`text-xs font-semibold ${
                              u.active === 1 ? 'text-emerald-700' : 'text-slate-400'
                            }`}
                          >
                            {u.active === 1 ? 'Activo' : 'Inactivo'}
                          </span>
                        </td>
                        <td className="py-2.5 px-4 text-right">
                          <div className="inline-flex items-center gap-1">
                            {!isGerencia && (
                              <button
                                type="button"
                                onClick={() => startEditUser(u)}
                                className="p-2 rounded-lg text-slate-600 hover:bg-slate-100 cursor-pointer"
                                title="Editar"
                              >
                                <Edit2 className="w-4 h-4" />
                              </button>
                            )}
                            <button
                              type="button"
                              onClick={() => toggleUserActive(u)}
                              className="p-2 rounded-lg text-slate-600 hover:bg-slate-100 cursor-pointer"
                              title={u.active === 1 ? 'Desactivar' : 'Activar'}
                            >
                              <Power className="w-4 h-4" />
                            </button>
                            <button
                              type="button"
                              onClick={() => setDeletingUser(u)}
                              className="p-2 rounded-lg text-red-600 hover:bg-red-50 cursor-pointer"
                              title="Eliminar conductor"
                            >
                              <Trash2 className="w-4 h-4" />
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* Pagination Bar (keeps lists clean & capped to 12 rows per page) */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between bg-white border border-slate-200 rounded-xl px-4 py-2.5 text-xs text-slate-600">
          <span>
            Página {safePage} de {totalPages} ({activeListLength} registros)
          </span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={safePage <= 1}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              className="h-8 px-2.5 rounded-lg border border-slate-200 hover:bg-slate-50 flex items-center gap-1 cursor-pointer disabled:opacity-40"
            >
              <ChevronLeft className="w-3.5 h-3.5" />
              <span>Anterior</span>
            </button>
            <button
              type="button"
              disabled={safePage >= totalPages}
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              className="h-8 px-2.5 rounded-lg border border-slate-200 hover:bg-slate-50 flex items-center gap-1 cursor-pointer disabled:opacity-40"
            >
              <span>Siguiente</span>
              <ChevronRight className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      )}

      {/* Transfer Vehicle Sede Modal */}
      {transferVehicle && (
        <div className="fixed inset-0 z-50 bg-slate-950/60 backdrop-blur-xs flex items-center justify-center p-4">
          <form
            onSubmit={handleTransferSede}
            className="w-full max-w-md bg-white rounded-2xl p-6 space-y-4 border border-slate-200"
          >
            <h3 className="text-base font-bold text-slate-900">
              Trasladar Camión de Sede
            </h3>
            <p className="text-xs text-slate-600">
              Camión: <strong className="font-mono">{transferVehicle.code} · {transferVehicle.plate}</strong>
              <br />
              Sede actual: <strong>{transferVehicle.sede_name || 'Sin sede'}</strong>
            </p>
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">
                Sede de destino
              </label>
              <select
                required
                value={transferTargetSedeId}
                onChange={(e) => setTransferTargetSedeId(e.target.value)}
                className="w-full h-10 px-3 rounded-lg border border-slate-300 text-sm bg-white"
              >
                <option value="">Selecciona la nueva sede...</option>
                {allSedes
                  .filter((s) => s.id !== transferVehicle.sede_id)
                  .map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
              </select>
            </div>
            <p className="text-[11px] text-slate-500">
              Si el camión tiene una jornada activa, el conductor deberá finalizarla antes del traslado.
            </p>
            <div className="grid grid-cols-2 gap-3 pt-1">
              <button
                type="button"
                onClick={() => setTransferVehicle(null)}
                className="h-10 rounded-lg border border-slate-300 text-slate-700 text-xs font-semibold hover:bg-slate-50 cursor-pointer"
              >
                Cancelar
              </button>
              <button
                type="submit"
                disabled={transferring || !transferTargetSedeId}
                className="h-10 rounded-lg bg-[#0e7a2d] hover:bg-[#0b6123] text-white text-xs font-semibold cursor-pointer disabled:opacity-60"
              >
                {transferring ? 'Trasladando...' : 'Confirmar Traslado'}
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Delete Driver Confirmation Modal */}
      {deletingUser && (
        <div className="fixed inset-0 z-50 bg-slate-950/60 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="w-full max-w-md bg-white rounded-2xl p-6 space-y-4 border border-slate-200">
            <h3 className="text-base font-bold text-slate-900">
              ¿Eliminar conductor?
            </h3>
            <p className="text-xs text-slate-600 leading-relaxed">
              Vas a eliminar a <strong>{deletingUser.full_name}</strong>{' '}
              {deletingUser.driver_code ? `(código ${deletingUser.driver_code})` : ''}.
              No podrá volver a iniciar sesión, y sus recorridos históricos permanecerán intactos en los reportes.
            </p>
            <div className="grid grid-cols-2 gap-3 pt-1">
              <button
                type="button"
                onClick={() => setDeletingUser(null)}
                className="h-10 rounded-lg border border-slate-300 text-slate-700 text-xs font-semibold hover:bg-slate-50 cursor-pointer"
              >
                Cancelar
              </button>
              <button
                type="button"
                disabled={deleting}
                onClick={handleConfirmDeleteUser}
                className="h-10 rounded-lg bg-red-600 hover:bg-red-700 text-white text-xs font-semibold cursor-pointer disabled:opacity-60"
              >
                {deleting ? 'Eliminando...' : 'Sí, Eliminar'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
