import { clientConfig } from '../config/client';

export type DateTimeInput = string | number | Date;

const DEFAULT_LOCALE = 'en-US';
const DEFAULT_TIMEZONE = 'UTC';

interface ZonedDateTimeParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

const toDate = (value: DateTimeInput | null | undefined): Date | null => {
  if (value === null || typeof value === 'undefined') {
    return null;
  }

  const parsed = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
};

const parsePartNumber = (value: string): number => {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : 0;
};

const buildDateTimeFormatter = (
  timeZone: string,
  options: Intl.DateTimeFormatOptions
): Intl.DateTimeFormat => {
  return new Intl.DateTimeFormat(DEFAULT_LOCALE, {
    timeZone,
    ...options,
  });
};

const buildZonedParts = (date: Date, timeZone: string): ZonedDateTimeParts => {
  const formatter = buildDateTimeFormatter(timeZone, {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
  const parts = formatter.formatToParts(date);

  const lookup = (type: Intl.DateTimeFormatPartTypes): number => {
    const part = parts.find((entry) => entry.type === type)?.value ?? '0';
    return parsePartNumber(part);
  };

  return {
    year: lookup('year'),
    month: lookup('month'),
    day: lookup('day'),
    hour: lookup('hour'),
    minute: lookup('minute'),
    second: lookup('second'),
  };
};

const padNumber = (value: number): string => {
  return String(value).padStart(2, '0');
};

const parseDateTimeInputValue = (value: string): ZonedDateTimeParts | null => {
  const match = value.match(
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/
  );
  if (!match) {
    return null;
  }

  return {
    year: parsePartNumber(match[1]),
    month: parsePartNumber(match[2]),
    day: parsePartNumber(match[3]),
    hour: parsePartNumber(match[4]),
    minute: parsePartNumber(match[5]),
    second: parsePartNumber(match[6] ?? '0'),
  };
};

const zonedPartsToUtcMs = (parts: ZonedDateTimeParts): number => {
  return Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
    0
  );
};

export const getDisplayTimezone = (preferredTimezone?: string | null): string => {
  const candidate = preferredTimezone?.trim() || clientConfig.timezone || DEFAULT_TIMEZONE;

  try {
    buildDateTimeFormatter(candidate, {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date());
    return candidate;
  } catch {
    return DEFAULT_TIMEZONE;
  }
};

export const formatAbsoluteDateTime = (
  value: DateTimeInput | null | undefined,
  timezone?: string
): string => {
  const parsed = toDate(value);
  if (!parsed) {
    return '-';
  }

  return buildDateTimeFormatter(getDisplayTimezone(timezone), {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
    timeZoneName: 'short',
  }).format(parsed);
};

export const formatCompactDateTime = (
  value: DateTimeInput | null | undefined,
  timezone?: string
): string => {
  const parsed = toDate(value);
  if (!parsed) {
    return '-';
  }

  return buildDateTimeFormatter(getDisplayTimezone(timezone), {
    month: 'short',
    day: '2-digit',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
    timeZoneName: 'short',
  }).format(parsed);
};

export const formatRelativeTime = (
  value: DateTimeInput | null | undefined
): string => {
  const parsed = toDate(value);
  if (!parsed) {
    return '-';
  }

  const diffMs = parsed.getTime() - Date.now();
  const absMinutes = Math.floor(Math.abs(diffMs) / 60000);

  if (absMinutes < 1) {
    return 'Just now';
  }

  const suffix = diffMs >= 0 ? 'from now' : 'ago';
  if (absMinutes < 60) {
    return `${absMinutes}m ${suffix}`;
  }

  const absHours = Math.floor(absMinutes / 60);
  if (absHours < 24) {
    return `${absHours}h ${suffix}`;
  }

  const absDays = Math.floor(absHours / 24);
  return `${absDays}d ${suffix}`;
};

export const formatDateTimeInputValue = (
  value: DateTimeInput | null | undefined,
  timezone?: string
): string => {
  const parsed = toDate(value);
  if (!parsed) {
    return '';
  }

  const parts = buildZonedParts(parsed, getDisplayTimezone(timezone));
  return `${parts.year}-${padNumber(parts.month)}-${padNumber(parts.day)}T${padNumber(parts.hour)}:${padNumber(parts.minute)}`;
};

export const parseDateTimeInputValueToUtcIso = (
  inputValue: string,
  timezone?: string
): string => {
  const desiredParts = parseDateTimeInputValue(inputValue);
  if (!desiredParts) {
    throw new Error('Invalid date/time input value.');
  }

  const resolvedTimezone = getDisplayTimezone(timezone);
  let guessUtcMs = zonedPartsToUtcMs(desiredParts);

  for (let iteration = 0; iteration < 4; iteration += 1) {
    const currentParts = buildZonedParts(new Date(guessUtcMs), resolvedTimezone);
    const deltaMs =
      zonedPartsToUtcMs(desiredParts) - zonedPartsToUtcMs(currentParts);

    if (deltaMs === 0) {
      return new Date(guessUtcMs).toISOString();
    }

    guessUtcMs += deltaMs;
  }

  return new Date(guessUtcMs).toISOString();
};
