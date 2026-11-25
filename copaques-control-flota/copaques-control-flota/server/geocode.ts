import { db } from './db.ts';

export async function reverseGeocode(lat: number, lng: number): Promise<string> {
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
    return 'Coordenadas inválidas';
  }

  const coordKey = `${lat.toFixed(4)},${lng.toFixed(4)}`;
  const cached = db
    .prepare('SELECT address FROM geocode_cache WHERE coord_key = ?')
    .get(coordKey) as { address: string } | undefined;

  if (cached && cached.address) {
    return cached.address;
  }

  const fallback = `Lat ${lat.toFixed(5)}, Lng ${lng.toFixed(5)}`;

  try {
    const url = new URL('https://nominatim.openstreetmap.org/reverse');
    url.searchParams.set('format', 'jsonv2');
    url.searchParams.set('lat', lat.toFixed(6));
    url.searchParams.set('lon', lng.toFixed(6));
    url.searchParams.set('zoom', '18');
    url.searchParams.set('addressdetails', '1');
    url.searchParams.set('accept-language', 'es');

    const response = await fetch(url.toString(), {
      headers: {
        'User-Agent': 'Copaques-Flota/1.0 (OpenStreetMap Nominatim)',
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(1800),
    });

    if (!response.ok) {
      return fallback;
    }

    const data = (await response.json()) as {
      display_name?: string;
      address?: {
        road?: string;
        house_number?: string;
        suburb?: string;
        neighbourhood?: string;
        city?: string;
        town?: string;
        village?: string;
        state?: string;
      };
    };

    let formatted = '';
    if (data.address) {
      const road = [data.address.road, data.address.house_number].filter(Boolean).join(' ');
      const area = data.address.suburb || data.address.neighbourhood || '';
      const city = data.address.city || data.address.town || data.address.village || data.address.state || '';
      formatted = [road, area, city].filter(Boolean).join(', ');
    }
    if (!formatted && data.display_name) {
      formatted = data.display_name.split(',').slice(0, 3).join(',').trim();
    }

    const finalAddress = formatted || fallback;
    db.prepare(
      'INSERT OR REPLACE INTO geocode_cache (coord_key, address, cached_at) VALUES (?, ?, ?)'
    ).run(coordKey, finalAddress, new Date().toISOString());

    return finalAddress;
  } catch {
    return fallback;
  }
}
