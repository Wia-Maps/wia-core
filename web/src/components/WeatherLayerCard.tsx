import { useEffect, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { haversineDistanceMeters } from '../core/mapMetrics';
import {
  fetchWeatherSnapshot,
  getFreshCachedWeather,
  WEATHER_CACHE_TTL_MS,
  WEATHER_SIGNIFICANT_DISTANCE_M,
  type WeatherSnapshot,
  type WeatherTone,
} from '../services/weather';

type WeatherCardStatus = 'idle' | 'loading' | 'ready' | 'error' | 'needs-location';

interface WeatherLayerCardProps {
  enabled: boolean;
  userLocation: [number, number] | null;
  gpsStatus: string;
  onRequestLocation: () => void;
}

const toneClasses: Record<WeatherTone, string> = {
  clear: 'border-amber-200 bg-gradient-to-br from-amber-50 via-white to-cyan-50 text-slate-900',
  cloudy: 'border-slate-200 bg-gradient-to-br from-slate-50 via-white to-sky-50 text-slate-900',
  rain: 'border-sky-200 bg-gradient-to-br from-sky-50 via-white to-cyan-50 text-slate-900',
  storm: 'border-indigo-200 bg-gradient-to-br from-indigo-50 via-white to-slate-100 text-slate-900',
  fog: 'border-slate-200 bg-gradient-to-br from-slate-100 via-white to-slate-50 text-slate-900',
  night: 'border-slate-300 bg-gradient-to-br from-slate-900 via-slate-800 to-cyan-950 text-white',
  unknown: 'border-slate-200 bg-white text-slate-900',
};

const chipClasses: Record<WeatherTone, string> = {
  clear: 'border-amber-200 bg-amber-100 text-amber-800',
  cloudy: 'border-slate-200 bg-slate-100 text-slate-700',
  rain: 'border-sky-200 bg-sky-100 text-sky-800',
  storm: 'border-indigo-200 bg-indigo-100 text-indigo-800',
  fog: 'border-slate-200 bg-slate-100 text-slate-700',
  night: 'border-white/20 bg-white/10 text-white',
  unknown: 'border-slate-200 bg-slate-100 text-slate-700',
};

const WeatherIcon: React.FC<{ tone: WeatherTone; isDay: boolean }> = ({ tone, isDay }) => {
  if (tone === 'rain') {
    return (
      <svg viewBox="0 0 48 48" className="h-11 w-11" aria-hidden="true">
        <path d="M15 30h20a8 8 0 0 0 1-16 12 12 0 0 0-22-3A9.5 9.5 0 0 0 15 30Z" fill="currentColor" opacity="0.18" />
        <path d="M15 30h20a8 8 0 0 0 1-16 12 12 0 0 0-22-3A9.5 9.5 0 0 0 15 30Z" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M17 36v3m8-5v4m8-5v3" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" />
      </svg>
    );
  }

  if (tone === 'storm') {
    return (
      <svg viewBox="0 0 48 48" className="h-11 w-11" aria-hidden="true">
        <path d="M15 29h20a8 8 0 0 0 1-16 12 12 0 0 0-22-3A9.5 9.5 0 0 0 15 29Z" fill="currentColor" opacity="0.16" />
        <path d="M25 27 19 38h6l-2 7 8-12h-6l4-6h-4Z" fill="currentColor" />
        <path d="M15 29h20a8 8 0 0 0 1-16 12 12 0 0 0-22-3A9.5 9.5 0 0 0 15 29Z" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  }

  if (tone === 'cloudy' || tone === 'fog') {
    return (
      <svg viewBox="0 0 48 48" className="h-11 w-11" aria-hidden="true">
        <path d="M15 31h20a8 8 0 0 0 1-16 12 12 0 0 0-22-3A9.5 9.5 0 0 0 15 31Z" fill="currentColor" opacity="0.17" />
        <path d="M15 31h20a8 8 0 0 0 1-16 12 12 0 0 0-22-3A9.5 9.5 0 0 0 15 31Z" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
        {tone === 'fog' && <path d="M12 37h24M16 42h16" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" opacity="0.72" />}
      </svg>
    );
  }

  if (tone === 'night' || !isDay) {
    return (
      <svg viewBox="0 0 48 48" className="h-11 w-11" aria-hidden="true">
        <path d="M32.5 34.5A15 15 0 0 1 19.7 10 16 16 0 1 0 38 28.3a14.8 14.8 0 0 1-5.5 6.2Z" fill="currentColor" opacity="0.82" />
        <path d="M35 10h.01M40 17h.01M30 5h.01" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
      </svg>
    );
  }

  return (
    <svg viewBox="0 0 48 48" className="h-11 w-11" aria-hidden="true">
      <circle cx="24" cy="24" r="9" fill="currentColor" opacity="0.22" />
      <circle cx="24" cy="24" r="9" fill="none" stroke="currentColor" strokeWidth="2.4" />
      <path d="M24 5v6M24 37v6M5 24h6M37 24h6M10.6 10.6l4.2 4.2M33.2 33.2l4.2 4.2M37.4 10.6l-4.2 4.2M14.8 33.2l-4.2 4.2" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" />
    </svg>
  );
};

const formatObservedTime = (timestamp: number): string => {
  if (!Number.isFinite(timestamp)) {
    return 'Live';
  }

  return new Intl.DateTimeFormat(undefined, {
    hour: 'numeric',
    minute: '2-digit',
  }).format(timestamp);
};

export const WeatherLayerCard: React.FC<WeatherLayerCardProps> = ({
  enabled,
  userLocation,
  gpsStatus,
  onRequestLocation,
}) => {
  const [status, setStatus] = useState<WeatherCardStatus>('idle');
  const [weather, setWeather] = useState<WeatherSnapshot | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [retryVersion, setRetryVersion] = useState(0);
  const lastFetchLocationRef = useRef<[number, number] | null>(null);

  useEffect(() => {
    if (!enabled) {
      return;
    }

    if (!userLocation) {
      setStatus('needs-location');
      setErrorMessage(null);
      return;
    }

    const lastFetchLocation = lastFetchLocationRef.current;
    const movedSignificantly =
      !lastFetchLocation ||
      haversineDistanceMeters(lastFetchLocation, userLocation) >= WEATHER_SIGNIFICANT_DISTANCE_M;
    const cached = getFreshCachedWeather(userLocation);

    if (!movedSignificantly && weather && cached) {
      return;
    }

    if (cached) {
      setWeather(cached);
      setStatus('ready');
      setErrorMessage(null);
      lastFetchLocationRef.current = userLocation;
      return;
    }

    const controller = new AbortController();
    setStatus(weather ? 'ready' : 'loading');
    setErrorMessage(null);

    void fetchWeatherSnapshot(userLocation, controller.signal)
      .then((snapshot) => {
        setWeather(snapshot);
        setStatus('ready');
        setErrorMessage(null);
        lastFetchLocationRef.current = userLocation;
      })
      .catch((error) => {
        if (controller.signal.aborted) {
          return;
        }

        setStatus(weather ? 'ready' : 'error');
        setErrorMessage(error instanceof Error ? error.message : 'Weather is unavailable right now.');
      });

    return () => {
      controller.abort();
    };
  }, [enabled, retryVersion, userLocation, weather]);

  useEffect(() => {
    if (!enabled || !weather) {
      return;
    }

    const refreshDelayMs = Math.max(30000, WEATHER_CACHE_TTL_MS - (Date.now() - weather.cachedAt) + 1000);
    const timeoutId = window.setTimeout(() => {
      setRetryVersion((value) => value + 1);
    }, refreshDelayMs);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [enabled, weather]);

  const tone = weather?.tone ?? 'unknown';
  const locationPending = status === 'needs-location' || gpsStatus === 'checking';
  const cardClass = toneClasses[tone];
  const mutedTextClass = tone === 'night' ? 'text-white/70' : 'text-slate-500';
  const supportingTextClass = tone === 'night' ? 'text-white/80' : 'text-slate-600';

  return (
    <motion.div
      className={`overflow-hidden rounded-2xl border px-3 py-3 shadow-[0_12px_28px_rgba(15,23,42,0.08)] transition-colors ${cardClass}`}
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.22 }}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className={`text-[11px] font-semibold uppercase tracking-[0.18em] ${mutedTextClass}`}>Local weather</p>
          <AnimatePresence mode="wait">
            {status === 'loading' ? (
              <motion.div
                key="weather-loading"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className="mt-3 space-y-2"
              >
                <div className="loading-shimmer h-7 w-28 rounded-full bg-white/70" />
                <div className="loading-shimmer h-4 w-44 rounded-full bg-white/60" />
              </motion.div>
            ) : weather ? (
              <motion.div key="weather-ready" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
                <div className="mt-2 flex flex-wrap items-end gap-x-3 gap-y-1">
                  <p className="font-['Outfit'] text-4xl font-semibold leading-none">
                    {Math.round(weather.temperatureC)}&deg;
                  </p>
                  <p className={`pb-1 text-sm font-semibold ${supportingTextClass}`}>{weather.condition}</p>
                </div>
                <p className={`mt-2 text-sm font-medium leading-5 ${supportingTextClass}`}>{weather.forecast}</p>
              </motion.div>
            ) : (
              <motion.div key="weather-empty" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
                <p className="mt-2 text-sm font-semibold">
                  {locationPending ? 'Waiting for your position' : 'Weather is temporarily unavailable'}
                </p>
                <p className={`mt-1 text-xs font-medium leading-5 ${supportingTextClass}`}>
                  {locationPending
                    ? 'WIA will load current conditions when GPS is ready.'
                    : errorMessage ?? 'Try again when your connection is stable.'}
                </p>
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        <div className={`grid h-14 w-14 shrink-0 place-items-center rounded-2xl border ${chipClasses[tone]}`}>
          {weather ? (
            <WeatherIcon tone={weather.tone} isDay={weather.isDay} />
          ) : (
            <span className="h-5 w-5 animate-spin rounded-full border-2 border-current border-t-transparent" />
          )}
        </div>
      </div>

      <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
        {weather ? (
          <span className={`rounded-full border px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.14em] ${chipClasses[tone]}`}>
            Updated {formatObservedTime(weather.observedAt)}
          </span>
        ) : (
          <span className={`text-[11px] font-semibold ${mutedTextClass}`}>
            {locationPending ? 'Location required' : 'Realtime conditions'}
          </span>
        )}
        {!userLocation && (
          <button
            type="button"
            onClick={onRequestLocation}
            className={`rounded-full border px-3 py-1 text-[11px] font-semibold transition ${
              tone === 'night'
                ? 'border-white/20 bg-white/10 text-white hover:bg-white/15'
                : 'border-slate-200 bg-white text-slate-700 hover:border-cyan-200'
            }`}
          >
            Enable GPS
          </button>
        )}
        {status === 'error' && userLocation && (
          <button
            type="button"
            onClick={() => {
              lastFetchLocationRef.current = null;
              setRetryVersion((value) => value + 1);
            }}
            className="rounded-full border border-slate-200 bg-white px-3 py-1 text-[11px] font-semibold text-slate-700 transition hover:border-cyan-200"
          >
            Retry
          </button>
        )}
      </div>
    </motion.div>
  );
};

export default WeatherLayerCard;
