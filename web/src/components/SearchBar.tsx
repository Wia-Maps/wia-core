import { useState, useEffect, useMemo, useRef, type ReactNode } from 'react';
import type { Feature, FeatureCollection, Geometry } from 'geojson';
import FellowshipBrandBadge from './FellowshipBrandBadge';
import {
  buildFellowshipSearchText,
  formatFellowshipSchedule,
  normalizeFellowshipCode,
  readFellowshipEntries,
  serviceKey,
} from '../core/fellowshipUtils';
import { resolveFeatureAnchorCoordinates, resolveFeatureId } from '../core/geoGeometry';
import { useAppStore, type StoredLocation } from '../store/useAppStore';

interface FeatureProperties {
  id?: string;
  name?: string;
  type?: string;
  short_code?: string;
  aliases?: string[];
  fellowships?: unknown;
  [key: string]: unknown;
}

type CampusFeature = Feature<Geometry, FeatureProperties>;
type CampusCollection = FeatureCollection<Geometry, FeatureProperties>;

interface SearchSelection {
  id: string;
  name: string;
  type: string;
  coordinates: [number, number];
  properties?: Record<string, unknown>;
  fellowshipFocusCode?: string | null;
  fellowshipServiceFocusKey?: string | null;
}

interface SearchResult {
  id: string;
  title: string;
  subtitle: string;
  badgeLabel: string;
  fellowshipCode?: string | null;
  location: SearchSelection;
}

interface SearchBarProps {
  onSearch?: (results: SearchResult[]) => void;
  onResultSelect?: (result: SearchResult) => void;
  onActiveChange?: (isActive: boolean) => void;
  geojsonData?: CampusCollection | null;
  disabled?: boolean;
  placeholder?: string;
  leadingSlot?: ReactNode;
  trailingSlot?: ReactNode;
  expandOnFocus?: boolean;
}

const toSearchResult = (feature: CampusFeature, index: number): SearchResult => ({
  id: resolveFeatureId(feature, index) ?? `feature_${index}`,
  title: feature.properties?.name ?? 'Unknown',
  subtitle: feature.properties?.type ?? 'Location',
  badgeLabel: 'Location',
  location: {
    id: resolveFeatureId(feature, index) ?? `feature_${index}`,
    name: feature.properties?.name ?? 'Unknown',
    type: feature.properties?.type ?? 'Location',
    coordinates: resolveFeatureAnchorCoordinates(feature),
    properties: feature.properties,
    fellowshipFocusCode: null,
    fellowshipServiceFocusKey: null,
  },
});

const toStoredSearchResult = (location: StoredLocation, badgeLabel: string): SearchResult => ({
  id: `${badgeLabel}_${location.id}`,
  title: location.name,
  subtitle: location.type,
  badgeLabel,
  fellowshipCode: null,
  location: {
    id: location.id,
    name: location.name,
    type: location.type,
    coordinates: location.coordinates,
    properties: location.properties,
    fellowshipFocusCode: null,
    fellowshipServiceFocusKey: null,
  },
});

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const bestMatchScore = (values: string[], query: string): number | null => {
  let bestScore: number | null = null;

  values.forEach((value) => {
    const normalized = value.trim().toLowerCase();

    if (!normalized) {
      return;
    }

    let score: number | null = null;

    if (normalized === query) {
      score = 0;
    } else if (normalized.startsWith(query)) {
      score = 1;
    } else if (normalized.includes(query)) {
      score = 2;
    }

    if (score === null) {
      return;
    }

    if (bestScore === null || score < bestScore) {
      bestScore = score;
    }
  });

  return bestScore;
};

const renderHighlightedText = (text: string, rawQuery: string): ReactNode => {
  const query = rawQuery.trim();
  if (!query) {
    return text;
  }

  const safeQuery = escapeRegExp(query);
  if (!safeQuery) {
    return text;
  }

  const matcher = new RegExp(`(${safeQuery})`, 'ig');
  const parts = text.split(matcher);

  if (parts.length <= 1) {
    return text;
  }

  return parts.map((part, index) => {
    const isMatch = part.toLowerCase() === query.toLowerCase();
    if (!isMatch) {
      return <span key={`${part}_${index}`}>{part}</span>;
    }

    return (
      <span key={`${part}_${index}`} className="font-semibold text-cyan-800">
        {part}
      </span>
    );
  });
};

/**
 * Real-time location search over loaded GeoJSON features.
 */
export const SearchBar: React.FC<SearchBarProps> = ({
  onSearch,
  onResultSelect,
  onActiveChange,
  geojsonData,
  disabled = false,
  placeholder = 'Search map',
  leadingSlot,
  trailingSlot,
  expandOnFocus = true,
}) => {
  const fellowshipBrandsByCode = useAppStore((state) => state.fellowshipBrandsByCode);
  const favouriteLocations = useAppStore((state) => state.favouriteLocations);
  const recentLocations = useAppStore((state) => state.recentLocations);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [showResults, setShowResults] = useState(false);
  const [isFocused, setIsFocused] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const rootRef = useRef<HTMLDivElement>(null);
  const resultRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const suggestionResults = useMemo(() => {
    const seen = new Set<string>();
    const suggestions: SearchResult[] = [];
    const addSuggestion = (result: SearchResult): void => {
      if (seen.has(result.location.id)) {
        return;
      }

      seen.add(result.location.id);
      suggestions.push(result);
    };

    favouriteLocations.slice(0, 3).forEach((location) => {
      addSuggestion(toStoredSearchResult(location, 'Saved'));
    });

    recentLocations.slice(0, 3).forEach((location) => {
      addSuggestion(toStoredSearchResult(location, 'Recent'));
    });

    geojsonData?.features.slice(0, 5).forEach((feature, index) => {
      addSuggestion(toSearchResult(feature, index));
    });

    return suggestions.slice(0, 6);
  }, [favouriteLocations, geojsonData, recentLocations]);

  useEffect((): void => {
    if (disabled) {
      setResults([]);
      setShowResults(false);
      setIsFocused(false);
      setActiveIndex(-1);
      return;
    }

    if (!query.trim() || !geojsonData?.features) {
      setResults([]);
      return;
    }

    const lowerQuery = query.trim().toLowerCase();

    const filtered = geojsonData.features
      .flatMap((feature, index) => {
        const locationResult = toSearchResult(feature, index);
        const locationProperties = feature.properties ?? {};
        const locationAliases = Array.isArray(locationProperties.aliases)
          ? locationProperties.aliases.filter((value): value is string => typeof value === 'string')
          : [];
        const locationScore = bestMatchScore(
          [
            String(locationProperties.name ?? ''),
            String(locationProperties.type ?? ''),
            String(locationProperties.short_code ?? ''),
            ...locationAliases,
          ],
          lowerQuery
        );
        const entries: Array<{ score: number; result: SearchResult }> = [];

        if (locationScore !== null) {
          entries.push({
            score: locationScore,
            result: locationResult,
          });
        }

        const fellowships = readFellowshipEntries(locationProperties.fellowships);
        fellowships.forEach((entry) => {
          entry.services.forEach((service) => {
            const score = bestMatchScore([buildFellowshipSearchText(entry, service)], lowerQuery);

            if (score === null) {
              return;
            }

            entries.push({
              score,
              result: {
                id: `${locationResult.id}::${entry.code}::${serviceKey(service)}`,
                title: entry.code,
                subtitle: `${locationResult.location.name} - ${formatFellowshipSchedule(service)}${service.roomLabel ? ` - ${service.roomLabel}` : ''}${service.infoLabel ? ` - ${service.infoLabel}` : ''}`,
                badgeLabel: 'Fellowship',
                fellowshipCode: entry.code,
                location: {
                  ...locationResult.location,
                  fellowshipFocusCode: entry.code,
                  fellowshipServiceFocusKey: serviceKey(service),
                },
              },
            });
          });
        });

        return entries;
      })
      .sort((left, right) => {
        if (left.score !== right.score) {
          return left.score - right.score;
        }

        return left.result.title.localeCompare(right.result.title);
      })
      .map((entry) => entry.result)
      .slice(0, 7);

    setResults(filtered);
    onSearch?.(filtered);
  }, [disabled, geojsonData, onSearch, query]);

  useEffect((): void => {
    if (results.length === 0) {
      setActiveIndex(-1);
      return;
    }

    setActiveIndex((previousIndex) => (previousIndex >= 0 && previousIndex < results.length ? previousIndex : -1));
  }, [results]);

  useEffect((): void => {
    if (!showResults || activeIndex < 0) {
      return;
    }

    resultRefs.current[activeIndex]?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex, showResults]);

  useEffect((): void => {
    onActiveChange?.(isFocused || showResults);
  }, [isFocused, onActiveChange, showResults]);


  useEffect((): (() => void) => {
    const handleOutsideClick = (event: MouseEvent): void => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) {
        setShowResults(false);
        setIsFocused(false);
        setActiveIndex(-1);
      }
    };

    window.addEventListener('click', handleOutsideClick);

    return (): void => {
      window.removeEventListener('click', handleOutsideClick);
    };
  }, []);

  const handleResultClick = (result: SearchResult): void => {
    setQuery(result.title);
    setShowResults(false);
    setIsFocused(false);
    setActiveIndex(-1);
    onResultSelect?.(result);
  };

  return (
    <div
      ref={rootRef}
      className={`relative overflow-visible transition-[width] duration-300 ease-out ${
        expandOnFocus && isFocused && !disabled ? 'w-[calc(100%+24px)] sm:w-[calc(100%+36px)]' : 'w-full'
      }`}
      onClick={() => {
        if (!disabled) {
          setIsFocused(true);
        }
      }}
    >
      <div
        className={`relative flex items-center gap-2 rounded-full border px-4 py-2 backdrop-blur-lg transition-all duration-300 ease-out ${
          disabled
            ? 'border-white/60 bg-white/88 opacity-95'
            : isFocused
            ? 'border-cyan-300/90 bg-white shadow-[0_0_0_3px_rgba(34,211,238,0.18),0_20px_44px_rgba(8,145,178,0.24)]'
            : 'border-white/75 bg-white/95 shadow-[0_14px_34px_rgba(15,23,42,0.2)]'
        }`}
      >
        {leadingSlot ?? (
          <span
            className={`pointer-events-none grid h-9 w-9 place-items-center rounded-full transition-all duration-300 ${
              disabled
                ? 'bg-slate-100 text-slate-500'
                : isFocused ? 'bg-cyan-100 text-cyan-700 shadow-sm' : 'bg-cyan-50/70 text-cyan-700'
            }`}
          >
            <svg viewBox="0 0 24 24" className="h-4.5 w-4.5" aria-hidden="true">
              <path d="m21 21-4.3-4.3M10.7 18a7.3 7.3 0 1 0 0-14.6 7.3 7.3 0 0 0 0 14.6Z" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </span>
        )}

        <input
          type="text"
          value={query}
          disabled={disabled}
          placeholder={disabled ? 'Loading campus places' : placeholder}
          onChange={(event) => {
            setQuery(event.target.value);
            setShowResults(true);
            setActiveIndex(-1);
          }}
          onFocus={() => {
            setShowResults(true);
            setIsFocused(true);
          }}
          onKeyDown={(event) => {
            if (event.key === 'ArrowDown') {
              event.preventDefault();
              setShowResults(true);
              if (results.length > 0) {
                setActiveIndex((previousIndex) =>
                  previousIndex < results.length - 1 ? previousIndex + 1 : 0
                );
              }
              return;
            }

            if (event.key === 'ArrowUp') {
              event.preventDefault();
              if (results.length > 0) {
                setActiveIndex((previousIndex) =>
                  previousIndex > 0 ? previousIndex - 1 : results.length - 1
                );
              }
              return;
            }

            if (event.key === 'Enter') {
              if (activeIndex >= 0 && results[activeIndex]) {
                event.preventDefault();
                handleResultClick(results[activeIndex]);
                return;
              }

              if (results.length > 0) {
                event.preventDefault();
                handleResultClick(results[0]);
              }
            }
          }}
          className="min-w-0 flex-1 appearance-none !border-0 !bg-transparent py-1 pr-2 text-base font-medium text-slate-800 !outline-none !ring-0 !shadow-none !font-[inherit] placeholder:font-medium placeholder:text-slate-400 focus:!outline-none focus:!ring-0 focus:!shadow-none disabled:cursor-default disabled:text-slate-500"
        />

        <div className="flex items-center gap-2">
          {disabled && (
            <span className="rounded-full border border-slate-200 bg-slate-100 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-500">
              Syncing
            </span>
          )}

          {!disabled && query.length > 0 && (
            <button
              type="button"
              onClick={() => {
                setQuery('');
                setResults([]);
                setActiveIndex(-1);
                setShowResults(false);
              }}
              className="grid h-9 w-9 place-items-center rounded-full border border-slate-200/90 bg-slate-50 text-slate-500 transition hover:border-slate-300 hover:bg-slate-100 hover:text-slate-700"
              aria-label="Clear search"
            >
              <svg viewBox="0 0 24 24" className="h-4 w-4" aria-hidden="true">
                <path d="M6 6 18 18M18 6 6 18" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" />
              </svg>
            </button>
          )}

          {trailingSlot}
        </div>
      </div>

      {!disabled && showResults && results.length > 0 && (
        <div className="absolute left-0 right-0 top-[calc(100%+10px)] z-50 max-h-96 overflow-y-auto rounded-3xl border border-slate-200/85 bg-white/96 p-2 shadow-[0_22px_46px_rgba(15,23,42,0.22)] backdrop-blur-xl">
          {results.map((result, index) => {
            const fellowshipBrand =
              result.fellowshipCode
                ? fellowshipBrandsByCode[normalizeFellowshipCode(result.fellowshipCode)] ?? null
                : null;

            return (
              <button
                key={result.id}
                ref={(node) => {
                  resultRefs.current[index] = node;
                }}
                type="button"
                onClick={() => handleResultClick(result)}
                onMouseEnter={() => setActiveIndex(index)}
                className={`block w-full rounded-xl px-3 py-2 text-left transition sm:px-4 sm:py-3 ${
                  activeIndex === index
                    ? 'bg-cyan-100 ring-1 ring-cyan-200'
                    : 'hover:bg-cyan-50'
                }`}
              >
                <div className="flex flex-wrap items-center gap-2">
                  {fellowshipBrand?.logoUrl ? (
                    <FellowshipBrandBadge
                      code={result.fellowshipCode ?? result.title}
                      logoUrl={fellowshipBrand.logoUrl}
                      alt={`${result.title} badge`}
                      className="inline-flex h-8 w-8 items-center justify-center overflow-hidden rounded-xl border border-cyan-200 bg-white p-1 shadow-sm"
                      imageClassName="h-full w-full object-contain"
                      fallbackClassName="text-[10px] font-semibold uppercase tracking-[0.16em] text-cyan-700"
                    />
                  ) : null}
                  <p className="text-lg font-semibold text-slate-900">{renderHighlightedText(result.title, query)}</p>
                  <span className="rounded-full border border-cyan-200 bg-cyan-50 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-cyan-700">
                    {result.badgeLabel}
                  </span>
                </div>
                <p className="mt-1 text-sm text-slate-600">{renderHighlightedText(result.subtitle, query)}</p>
              </button>
            );
          })}
        </div>
      )}

      {!disabled && showResults && query.trim().length === 0 && suggestionResults.length > 0 && (
        <div className="absolute left-0 right-0 top-[calc(100%+10px)] z-50 max-h-96 overflow-y-auto rounded-3xl border border-slate-200/85 bg-white/96 p-2 shadow-[0_22px_46px_rgba(15,23,42,0.22)] backdrop-blur-xl">
          <div className="px-3 pb-2 pt-1">
            <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">Start here</p>
          </div>
          {suggestionResults.map((result) => (
            <button
              key={result.id}
              type="button"
              onClick={() => handleResultClick(result)}
              className="block w-full rounded-xl px-3 py-2 text-left transition hover:bg-cyan-50 sm:px-4 sm:py-3"
            >
              <div className="flex flex-wrap items-center gap-2">
                <p className="text-lg font-semibold text-slate-900">{result.title}</p>
                <span className="rounded-full border border-cyan-200 bg-cyan-50 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-cyan-700">
                  {result.badgeLabel}
                </span>
              </div>
              <p className="mt-1 text-sm text-slate-600">{result.subtitle}</p>
            </button>
          ))}
        </div>
      )}

      {!disabled && showResults && query.length > 0 && results.length === 0 && (
        <div className="absolute left-0 right-0 top-[calc(100%+10px)] z-50 rounded-3xl border border-slate-200/85 bg-white/96 px-4 py-3 shadow-[0_18px_42px_rgba(15,23,42,0.2)]">
          <p className="text-sm font-medium text-slate-600">No location found for &quot;{query}&quot;.</p>
        </div>
      )}
    </div>
  );
};

export default SearchBar;
