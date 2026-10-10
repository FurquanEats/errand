import { getSettings } from './settings.ts';

/** Open-Meteo: free, no key. Powers the living background and gives the assistant local context. */

let cache: { key: string; at: number; data: Weather } | null = null;

export interface Weather {
  location: string;
  temperature: number;
  apparent: number;
  code: number;
  condition: string;
  isDay: boolean;
  high: number;
  low: number;
  precipitationChance: number;
  sunrise: string;
  sunset: string;
  unit: 'C' | 'F';
}

const CONDITIONS: Record<number, string> = {
  0: 'Clear',
  1: 'Mostly clear',
  2: 'Partly cloudy',
  3: 'Overcast',
  45: 'Fog',
  48: 'Fog',
  51: 'Light drizzle',
  53: 'Drizzle',
  55: 'Heavy drizzle',
  61: 'Light rain',
  63: 'Rain',
  65: 'Heavy rain',
  66: 'Freezing rain',
  67: 'Freezing rain',
  71: 'Light snow',
  73: 'Snow',
  75: 'Heavy snow',
  77: 'Snow grains',
  80: 'Showers',
  81: 'Showers',
  82: 'Violent showers',
  85: 'Snow showers',
  86: 'Snow showers',
  95: 'Thunderstorm',
  96: 'Thunderstorm with hail',
  99: 'Thunderstorm with hail',
};

export async function getWeather(): Promise<Weather | null> {
  const loc = getSettings().location;
  if (!loc) return null;
  const key = `${loc.lat},${loc.lon}`;
  if (cache && cache.key === key && Date.now() - cache.at < 15 * 60_000) return cache.data;
  const fahrenheit = /^(America\/(New_York|Chicago|Denver|Los_Angeles|Phoenix|Anchorage|Detroit|Indiana|Boise)|Pacific\/Honolulu)/.test(getSettings().timezone);
  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${loc.lat}&longitude=${loc.lon}` +
    `&current=temperature_2m,apparent_temperature,weather_code,is_day&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max,sunrise,sunset` +
    `&timezone=auto&forecast_days=1${fahrenheit ? '&temperature_unit=fahrenheit' : ''}`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
    const b: any = await res.json();
    const data: Weather = {
      location: loc.name,
      temperature: Math.round(b.current.temperature_2m),
      apparent: Math.round(b.current.apparent_temperature),
      code: b.current.weather_code,
      condition: CONDITIONS[b.current.weather_code] ?? 'Unknown',
      isDay: !!b.current.is_day,
      high: Math.round(b.daily.temperature_2m_max[0]),
      low: Math.round(b.daily.temperature_2m_min[0]),
      precipitationChance: b.daily.precipitation_probability_max[0] ?? 0,
      sunrise: b.daily.sunrise[0],
      sunset: b.daily.sunset[0],
      unit: fahrenheit ? 'F' : 'C',
    };
    cache = { key, at: Date.now(), data };
    return data;
  } catch {
    return cache?.data ?? null;
  }
}

interface Place {
  name: string;
  lat: number;
  lon: number;
  timezone: string;
}

/**
 * Find places by name. Accepts "lat,lon", "Town", or "Town, Region, Country". Open-Meteo's
 * geocoder is tried first (it includes time zones); OpenStreetMap fills in what it misses
 * (states, smaller towns, places written with their region).
 */
export async function geocode(query: string): Promise<Place[]> {
  const coords = query.match(/^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/);
  if (coords) return [{ name: query.trim(), lat: Number(coords[1]), lon: Number(coords[2]), timezone: await timezoneAt(Number(coords[1]), Number(coords[2])) }];
  const plain = (v: unknown) =>
    String(v ?? '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase();
  const [head, ...rest] = query
    .split(',')
    .map(plain)
    .map((s) => s.trim())
    .filter(Boolean);
  if (!head) return [];
  const b: any = await (await fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(head)}&count=10`)).json();
  const found = (b.results ?? [])
    .filter((r: any) => plain(r.name) === head && rest.every((p) => [r.admin1, r.admin2, r.country, r.country_code].some((v) => plain(v).includes(p))))
    .sort((a: any, c: any) => (c.population ?? 0) - (a.population ?? 0));
  const places: Place[] = found
    .slice(0, 5)
    .map((r: any) => ({ name: [r.name, r.admin1, r.country].filter(Boolean).join(', '), lat: r.latitude, lon: r.longitude, timezone: r.timezone }));
  // A sizeable town is a confident answer. Otherwise (a village, a state, a misspelling) ask OpenStreetMap too, and trust it first.
  if ((found[0]?.population ?? 0) >= 100_000) return places;
  return [...(await openStreetMap(query).catch(() => [])), ...places].slice(0, 5);
}

async function openStreetMap(query: string): Promise<Place[]> {
  const osm: any[] = await (
    await fetch(`https://nominatim.openstreetmap.org/search?format=jsonv2&limit=3&q=${encodeURIComponent(query)}`, {
      headers: { 'user-agent': 'Errand (https://github.com/FurquanEats/errand)' },
      signal: AbortSignal.timeout(10000),
    })
  ).json();
  return Promise.all(
    osm.map(async (r) => ({
      name: String(r.display_name)
        .split(', ')
        .filter((p: string) => !/^\d+$/.test(p))
        .slice(0, 3)
        .join(', '),
      lat: Number(r.lat),
      lon: Number(r.lon),
      timezone: await timezoneAt(Number(r.lat), Number(r.lon)),
    })),
  );
}

async function timezoneAt(lat: number, lon: number) {
  const b: any = await (
    await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&timezone=auto&forecast_days=1`)
  )
    .json()
    .catch(() => ({}));
  return String(b.timezone ?? '');
}

/** Daily forecast for the saved location or any place (Open-Meteo, no key), up to 16 days. */
export async function forecast(place?: string, days = 7) {
  const s = getSettings();
  const loc = place ? (await geocode(place))[0] : s.location;
  if (!loc) return { error: place ? `Could not find "${place}"` : 'No location set. Tell me your city.' };
  const fahrenheit = /^America\/|^Pacific\/Honolulu/.test(place ? ((loc as { timezone?: string }).timezone ?? '') : s.timezone);
  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${loc.lat}&longitude=${loc.lon}&timezone=auto&forecast_days=${Math.min(16, Math.max(1, days))}` +
    `&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,wind_speed_10m_max${fahrenheit ? '&temperature_unit=fahrenheit' : ''}`;
  const d: any = (await (await fetch(url, { signal: AbortSignal.timeout(10000) })).json()).daily;
  return {
    place: loc.name,
    unit: fahrenheit ? 'F' : 'C',
    days: d.time.map((date: string, i: number) => ({
      date,
      condition: CONDITIONS[d.weather_code[i]] ?? 'Unknown',
      high: Math.round(d.temperature_2m_max[i]),
      low: Math.round(d.temperature_2m_min[i]),
      rainChance: d.precipitation_probability_max[i] ?? 0,
      windKmh: Math.round(d.wind_speed_10m_max[i]),
    })),
  };
}

export function weatherLine(w: Weather | null) {
  return w
    ? `${w.location}: ${w.temperature}°${w.unit}, ${w.condition}, high ${w.high}° / low ${w.low}°, ${w.precipitationChance}% chance of precipitation.`
    : '';
}
