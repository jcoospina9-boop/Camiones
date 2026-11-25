import { useState, type FormEvent } from 'react';
import { Edit2, Plus, Power, Search, Truck, Users as UsersIcon } from 'lucide-react';
import { apiFetch } from '../lib/api.ts';
import type { User, UserRole, Vehicle } from '../types.ts';

interface FleetUsersViewProps {
  vehicles: Vehicle[];
  users: User[];
  onRefresh: () => Promise<void>;
}

export function FleetUsersView({ vehicles, users, onRefresh }: FleetUsersViewProps) {
  const [subTab, setSubTab] = useState<'vehicles' | 'users'>('vehicles');
  const [search, setSearch] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Vehicle form state
  const [editingVehicleId, setEditingVehicleId] = useState<number | null>(null);
  const [vCode, setVCode] = useState('');
  const [vPlate, setVPlate] = useState('');
  const [vBrand, setVBrand] = useState('');
  const [vModel, setVModel] = useState('');
  const [vCapacity, setVCapacity] = useState('');

  // User form state
  const [editingUserId, setEditingUserId] = useState<number | null>(null);
  const [uUsername, setUUsername] = useState('');
  const [uFullName, setUFullName] = useState('');
  const [uPassword, setUPassword] = useState('');
  const [uRole, setURole] = useState<UserRole>('CONDUCTOR');
  const [uVehicleId, setUVehicleId] = useState<string>('');

  function resetVehicleForm() {
    setEditingVehicleId(null);
    setVCode('');
    setVPlate('');
    setVBrand('');
    setVModel('');
    setVCapacity('');
  }

  function startEditVehicle(v: Vehicle) {
    setEditingVehicleId(v.id);
    setVCode(v.code);
    setVPlate(v.plate);
    setVBrand(v.brand);
    setVModel(v.model);
    setVCapacity(v.capacity_tons ? String(v.capacity_tons) : '');
  }

  async function handleSaveVehicle(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSaving(true);
    try {
      const payload = {
        code: vCode,
        plate: vPlate,
        brand: vBrand,
        model: vModel,
        capacity_tons: Number(vCapacity) || 0,
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

  function resetUserForm() {
    setEditingUserId(null);
    setUUsername('');
    setUFullName('');
    setUPassword('');
    setURole('CONDUCTOR');
    setUVehicleId('');
  }

  function startEditUser(u: User) {
    setEditingUserId(u.id);
    setUUsername(u.username);
    setUFullName(u.full_name);
    setUPassword('');
    setURole(u.role);
    setUVehicleId(u.vehicle_id ? String(u.vehicle_id) : '');
  }

  async function handleSaveUser(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSaving(true);
    try {
      if (editingUserId) {
        await apiFetch(`/api/admin/users/${editingUserId}`, {
          method: 'PUT',
          body: JSON.stringify({
            full_name: uFullName,
            role: uRole,
            vehicle_id: uRole === 'CONDUCTOR' && uVehicleId ? Number(uVehicleId) : null,
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
            role: uRole,
            vehicle_id: uRole === 'CONDUCTOR' && uVehicleId ? Number(uVehicleId) : null,
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

  const filteredVehicles = vehicles.filter((v) => {
    const q = search.trim().toLowerCase();
    if (!q) return true;
    return (
      v.code.toLowerCase().includes(q) ||
      v.plate.toLowerCase().includes(q) ||
      v.brand.toLowerCase().includes(q) ||
      (v.assigned_driver_name || '').toLowerCase().includes(q)
    );
  });

  const filteredUsers = users.filter((u) => {
    const q = search.trim().toLowerCase();
    if (!q) return true;
    return (
      u.username.toLowerCase().includes(q) ||
      u.full_name.toLowerCase().includes(q) ||
      (u.vehicle_code || '').toLowerCase().includes(q) ||
      (u.vehicle_plate || '').toLowerCase().includes(q)
    );
  });

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-1 p-1 bg-slate-200/70 rounded-lg">
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
            onClick={() => setSubTab('users')}
            className={`px-4 py-1.5 rounded-md text-xs font-semibold flex items-center gap-2 cursor-pointer transition-colors whitespace-nowrap shrink-0 ${
              subTab === 'users'
                ? 'bg-white text-slate-900 shadow-xs'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            <UsersIcon className="w-4 h-4" />
            <span>Conductores y Gerencia ({users.length})</span>
          </button>
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

      {subTab === 'vehicles' ? (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-5 items-start">
          {/* Vehicle Form */}
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

          {/* Vehicles Table */}
          <div className="lg:col-span-8 bg-white border border-slate-200 rounded-xl overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse text-sm">
                <thead>
                  <tr className="bg-slate-50 border-b border-slate-200 text-xs font-semibold text-slate-600">
                    <th className="py-2.5 px-4">Código</th>
                    <th className="py-2.5 px-4">Placa</th>
                    <th className="py-2.5 px-4">Vehículo</th>
                    <th className="py-2.5 px-4 text-right">Capacidad</th>
                    <th className="py-2.5 px-4">Conductor Asignado</th>
                    <th className="py-2.5 px-4">Estado</th>
                    <th className="py-2.5 px-4 text-right">Acciones</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {filteredVehicles.length === 0 ? (
                    <tr>
                      <td colSpan={7} className="py-8 text-center text-slate-500">
                        No hay camiones registrados. Agrega el primer camión en el formulario.
                      </td>
                    </tr>
                  ) : (
                    filteredVehicles.map((v) => (
                      <tr key={v.id} className="hover:bg-slate-50">
                        <td className="py-2.5 px-4 font-bold font-mono text-slate-900">{v.code}</td>
                        <td className="py-2.5 px-4 font-mono text-slate-700">{v.plate}</td>
                        <td className="py-2.5 px-4 text-slate-600">
                          {[v.brand, v.model].filter(Boolean).join(' ') || '-'}
                        </td>
                        <td className="py-2.5 px-4 text-right font-mono tabular-nums text-slate-700">
                          {v.capacity_tons > 0 ? `${v.capacity_tons} t` : '-'}
                        </td>
                        <td className="py-2.5 px-4 text-slate-700">
                          {v.assigned_driver_name ? (
                            <span>
                              {v.assigned_driver_name}{' '}
                              <span className="text-xs text-slate-400 font-mono">
                                ({v.assigned_username})
                              </span>
                            </span>
                          ) : (
                            <span className="text-xs text-amber-700">Sin asignar</span>
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
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-5 items-start">
          {/* User Form */}
          <div className="lg:col-span-4 bg-white border border-slate-200 rounded-xl p-5">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-base font-bold text-slate-900">
                {editingUserId ? 'Editar Usuario' : 'Crear Usuario'}
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
                  Usuario de acceso
                </label>
                <input
                  type="text"
                  required
                  disabled={Boolean(editingUserId)}
                  value={uUsername}
                  onChange={(e) => setUUsername(e.target.value)}
                  placeholder="camion01"
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
                  <option value="CONDUCTOR">Conductor (Camión)</option>
                  <option value="GERENCIA">Gerencia (Administrador)</option>
                </select>
              </div>

              {uRole === 'CONDUCTOR' && (
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    Camión asignado
                  </label>
                  <select
                    required
                    value={uVehicleId}
                    onChange={(e) => setUVehicleId(e.target.value)}
                    className="w-full h-10 px-3 rounded-lg border border-slate-300 text-sm bg-white"
                  >
                    <option value="">Selecciona un camión...</option>
                    {vehicles
                      .filter((v) => v.active === 1)
                      .map((v) => (
                        <option key={v.id} value={v.id}>
                          {v.code} · {v.plate}
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
                <span>{saving ? 'Guardando...' : editingUserId ? 'Guardar Usuario' : 'Crear Usuario'}</span>
              </button>
            </form>
          </div>

          {/* Users Table */}
          <div className="lg:col-span-8 bg-white border border-slate-200 rounded-xl overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse text-sm">
                <thead>
                  <tr className="bg-slate-50 border-b border-slate-200 text-xs font-semibold text-slate-600">
                    <th className="py-2.5 px-4">Nombre</th>
                    <th className="py-2.5 px-4">Usuario</th>
                    <th className="py-2.5 px-4">Rol</th>
                    <th className="py-2.5 px-4">Camión Asignado</th>
                    <th className="py-2.5 px-4">Estado</th>
                    <th className="py-2.5 px-4 text-right">Acciones</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {filteredUsers.map((u) => (
                    <tr key={u.id} className="hover:bg-slate-50">
                      <td className="py-2.5 px-4 font-semibold text-slate-900">{u.full_name}</td>
                      <td className="py-2.5 px-4 font-mono text-slate-700">{u.username}</td>
                      <td className="py-2.5 px-4 text-xs font-semibold text-slate-700">
                        {u.role === 'GERENCIA' ? 'Gerencia' : 'Conductor'}
                      </td>
                      <td className="py-2.5 px-4 font-mono text-xs text-slate-600">
                        {u.vehicle_code ? `${u.vehicle_code} · ${u.vehicle_plate}` : '-'}
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
    </div>
  );
}
