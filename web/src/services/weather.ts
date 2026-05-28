export type WeatherTone = 'clear' | 'cloudy' | 'rain' | 'storm' | 'fog' | 'night' | 'unknown';

export interface WeatherSnapshot {
  location: [number, number];
  temperatureC: number;
  condition: string;
  weatherCode: number;
  isDay: boolean;
  forecast: string;
  tone: WeatherTone;
  observedAt: number;
  cachedAt: number;
}

interface OpenMeteoCurrent {
  time?: string;
  temperature_2m?: number;
  weather_code?: number;
  is_day?: number;
}

interface OpenMeteoHourly {
  time?: string[];
  temperature_2m?: number[];
  weather_code?: number[];
  precipitation_probability?: number[];
}

interface OpenMeteoResponse {
  current?: OpenMeteoCurrent;
  hourly?: OpenMeteoHourly;
}

const WEATHER_CACHE_PREFIX = 'wia_weather_v1';
export const WEATHER_CACHE_TTL_MS = 10 * 60 * 1000;
export const WEATHER_SIGNIFICANT_DISTANCE_M = 2500;

const weatherLabels: Record<number, string> = {
  0: 'Clear sky',
  1: 'Mostly clear',
  2: 'Partly cloudy',
  3: 'Overcast',
  45: 'Fog',
  48: 'Depositing fog',
  51: 'Light drizzle',
  53: 'Drizzle',
  55: 'Dense drizzle',
  56: 'Freezing drizzle',
  57: 'Freezing drizzle',
  61: 'Light rain',
  63: 'Rain',
  65: 'Heavy rain',
  66: 'Freezing rain',
  67: 'Freezing rain',
  71: 'Light snow',
  73: 'Snow',
  75: 'Heavy snow',
  77: 'Snow grains',
  80: 'Light showers',
  81: 'Showers',
  82: 'Heavy showers',
  85: 'Snow showers',
  86: 'Snow showers',
  95: 'Thunderstorm',
  96: 'Thunderstorm with hail',
  99: 'Thunderstorm with hail',
};

const toCacheKey = ([lat, lng]: [number, number]): string => {
  const roundedLat = lat.toFixed(2);
  const roundedLng = lng.toFixed(2);
  return `${WEATHER_CACHE_PREFIX}_${roundedLat}_${roundedLng}`;
};

const getWeatherTone = (code: number, isDay: boolean): WeatherTone => {
  if (!Number.isFinite(code)) {
    return 'unknown';
  }

  if (!isDay && code <= 3) {
    return 'night';
  }

  if (code === 0 || code === 1) {
    return 'clear';
  }

  if (code === 2 || code === 3) {
    return 'cloudy';
  }

  if (code === 45 || code === 48) {
    return 'fog';
  }

  if (code >= 95) {
    return 'storm';
  }

  if (code >= 51 && code <= 86) {
    return 'rain';
  }

  return 'unknown';
};

const readCachedWeather = (location: [number, number]): WeatherSnapshot | null => {
  if (typeof window === 'undefined') {
    return null;
  }

  try {
    const rawValue = window.localStorage.getItem(toCacheKey(location));
    if (!rawValue) {
      return null;
    }

    const parsed = JSON.parse(rawValue) as WeatherSnapshot;
    if (
      !Array.isArray(parsed.location) ||
      typeof parsed.temperatureC !== 'number' ||
      typeof parsed.condition !== 'string' ||
      typeof parsed.cachedAt !== 'number'
    ) {
      return null;
    }

    return parsed;
  } catch {
    return null;
  }
};

const writeCachedWeather = (snapshot: WeatherSnapshot): void => {
  if (typeof window === 'undefined') {
    return;
  }

  try {
    window.localStorage.setItem(toCacheKey(snapshot.location), JSON.stringify(snapshot));
  } catch {
    // Weather is opportunistic; storage failure should not affect the map.
  }
};

export const getFreshCachedWeather = (location: [number, number]): WeatherSnapshot | null => {
  const cached = readCachedWeather(location);
  if (!cached || Date.now() - cached.cachedAt > WEATHER_CACHE_TTL_MS) {
    return null;
  }

  return cached;
};

const buildForecast = (current: OpenMeteoCurrent, hourly: OpenMeteoHourly | undefined): string => {
  const times = hourly?.time ?? [];
  const temperatures = hourly?.temperature_2m ?? [];
  const codes = hourly?.weather_code ?? [];
  const precipitation = hourly?.precipitation_probability ?? [];
  const currentTimeMs = current.time ? new Date(current.time).getTime() : Date.now();
  const nextIndexes = times
    .map((time, index) => ({ index, timeMs: new Date(time).getTime() }))
    .filter((entry) => Number.isFinite(entry.timeMs) && entry.timeMs > currentTimeMs)
    .slice(0, 6)
    .map((entry) => entry.index);

  if (nextIndexes.length === 0) {
    return 'Conditions should stay close to the current pattern.';
  }

  const likelyRainIndex = nextIndexes.find((index) => (precipitation[index] ?? 0) >= 45 || (codes[index] ?? 0) >= 51);
  if (typeof likelyRainIndex === 'number') {
    const probability = precipitation[likelyRainIndex];
    return typeof probability === 'number'
      ? `Rain chance rises to ${Math.round(probability)}% soon.`
      : 'Showers may develop soon.';
  }

  const currentTemp = current.temperature_2m;
  const nextTemps = nextIndexes
    .map((index) => temperatures[index])
    .filter((value): value is number => typeof value === 'number' && Number.isFinite(value));

  if (typeof currentTemp === 'number' && nextTemps.length > 0) {
    const nextAverage = nextTemps.reduce((sum, value) => sum + value, 0) / nextTemps.length;
    const delta = nextAverage - currentTemp;
    if (delta >= 2) {
      return 'Getting a little warmer over the next few hours.';
    }

    if (delta <= -2) {
      return 'Slightly cooler conditions are expected soon.';
    }
  }

  const nextCode = nextIndexes.map((index) => codes[index]).find((value) => typeof value === 'number');
  if (typeof nextCode === 'number' && nextCode !== current.weather_code) {
    return `Trending toward ${weatherLabels[nextCode]?.toLowerCase() ?? 'changing conditions'}.`;
  }

  return 'Steady conditions expected for the next few hours.';
};

const buildWeatherUrl = ([lat, lng]: [number, number]): string => {
  const params = new URLSearchParams({
    latitude: lat.toFixed(5),
    longitude: lng.toFixed(5),
    current: 'temperature_2m,weather_code,is_day',
    hourly: 'temperature_2m,weather_code,precipitation_probability',
    forecast_days: '1',
    forecast_hours: '8',
    timezone: 'auto',
  });

  return `https://api.open-meteo.com/v1/forecast?${params.toString()}`;
};

export const fetchWeatherSnapshot = async (
  location: [number, number],
  signal?: AbortSignal
): Promise<WeatherSnapshot> => {
  const cached = getFreshCachedWeather(location);
  if (cached) {
    return cached;
  }

  const response = await fetch(buildWeatherUrl(location), { signal });
  if (!response.ok) {
    throw new Error(`Weather request failed with ${response.status}`);
  }

  const payload = (await response.json()) as OpenMeteoResponse;
  const current = payload.current;
  const temperatureC = current?.temperature_2m;
  const weatherCode = current?.weather_code;

  if (
    !current ||
    typeof temperatureC !== 'number' ||
    typeof weatherCode !== 'number' ||
    !Number.isFinite(temperatureC) ||
    !Number.isFinite(weatherCode)
  ) {
    throw new Error('Weather response did not include current conditions');
  }

  const isDay = current.is_day !== 0;
  const snapshot: WeatherSnapshot = {
    location,
    temperatureC,
    condition: weatherLabels[weatherCode] ?? 'Current conditions',
    weatherCode,
    isDay,
    forecast: buildForecast(current, payload.hourly),
    tone: getWeatherTone(weatherCode, isDay),
    observedAt: current.time ? new Date(current.time).getTime() : Date.now(),
    cachedAt: Date.now(),
  };

  writeCachedWeather(snapshot);
  return snapshot;
};
