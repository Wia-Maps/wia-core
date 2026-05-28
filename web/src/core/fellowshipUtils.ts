export interface FellowshipServiceEntry {
  dayLabel: string;
  timeLabel: string;
  roomLabel?: string | null;
  infoLabel?: string | null;
}

export interface FellowshipVenueEntry {
  code: string;
  name: string;
  contact?: string;
  services: FellowshipServiceEntry[];
}

export interface FellowshipBrandRecord {
  code: string;
  name: string | null;
  logoUrl: string | null;
  contact?: string | null;
  mimeType?: string | null;
  updatedAt: string | null;
}

const trimString = (value: unknown): string => {
  return typeof value === 'string' ? value.trim() : '';
};

const twoDigit = (value: number): string => value.toString().padStart(2, '0');

export const normalizeFellowshipCode = (value: unknown): string => {
  return trimString(value).toUpperCase();
};

export const toTimeInputValue = (value: unknown): string => {
  const trimmed = trimString(value);

  if (!trimmed) {
    return '';
  }

  const twentyFourHourMatch = trimmed.match(/^([01]?\d|2[0-3]):([0-5]\d)$/);
  if (twentyFourHourMatch) {
    return `${twoDigit(Number(twentyFourHourMatch[1]))}:${twentyFourHourMatch[2]}`;
  }

  const twelveHourMatch = trimmed.match(/^(\d{1,2})(?::(\d{2}))?\s*(AM|PM)$/i);
  if (!twelveHourMatch) {
    return '';
  }

  let hours = Number(twelveHourMatch[1]);
  const minutes = twelveHourMatch[2] ?? '00';
  const meridiem = twelveHourMatch[3].toUpperCase();

  if (hours === 12) {
    hours = meridiem === 'AM' ? 0 : 12;
  } else if (meridiem === 'PM') {
    hours += 12;
  }

  return `${twoDigit(hours)}:${minutes}`;
};

export const formatDisplayTimeLabel = (value: unknown): string => {
  const timeInputValue = toTimeInputValue(value);

  if (!timeInputValue) {
    return trimString(value);
  }

  const [rawHours, rawMinutes] = timeInputValue.split(':');
  const hours = Number(rawHours);
  const minutes = Number(rawMinutes);
  const normalizedHours = ((hours + 11) % 12) + 1;
  const meridiem = hours >= 12 ? 'PM' : 'AM';

  if (minutes === 0) {
    return `${normalizedHours} ${meridiem}`;
  }

  return `${normalizedHours}:${twoDigit(minutes)} ${meridiem}`;
};

export const normalizeFellowshipService = (value: unknown): FellowshipServiceEntry | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  const candidate = value as Record<string, unknown>;
  const dayLabel = trimString(candidate.dayLabel);
  const timeLabel = trimString(candidate.timeLabel);
  const roomLabel = trimString(candidate.roomLabel || candidate.venueLabel);
  const infoLabel = trimString(candidate.infoLabel);

  if (!dayLabel || !timeLabel) {
    return null;
  }

  return {
    dayLabel,
    timeLabel,
    roomLabel: roomLabel || null,
    infoLabel: infoLabel || null,
  };
};

export const serviceKey = (service: FellowshipServiceEntry): string => {
  return [service.dayLabel, service.timeLabel, service.roomLabel ?? '', service.infoLabel ?? ''].join('|');
};

export const normalizeFellowshipEntry = (value: unknown): FellowshipVenueEntry | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  const candidate = value as Record<string, unknown>;
  const code = normalizeFellowshipCode(candidate.code);
  const name = trimString(candidate.name);
  const serviceEntries = Array.isArray(candidate.services)
    ? candidate.services
    : [candidate];
  const services = serviceEntries
    .map((entry) => normalizeFellowshipService(entry))
    .filter((entry): entry is FellowshipServiceEntry => Boolean(entry));

  const contact = trimString(candidate.contact);

  if (!code || !name || services.length === 0) {
    return null;
  }

  return {
    code,
    name,
    contact: contact || undefined,
    services,
  };
};

export const readFellowshipEntries = (value: unknown): FellowshipVenueEntry[] => {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((entry) => normalizeFellowshipEntry(entry))
    .filter((entry): entry is FellowshipVenueEntry => Boolean(entry));
};

export const findFellowshipEntry = (
  entries: FellowshipVenueEntry[],
  code: string | null | undefined
): FellowshipVenueEntry | null => {
  const normalizedCode = normalizeFellowshipCode(code);

  if (!normalizedCode) {
    return null;
  }

  return entries.find((entry) => entry.code === normalizedCode) ?? null;
};

export const formatFellowshipSchedule = (service: FellowshipServiceEntry): string => {
  return `${service.dayLabel}, ${formatDisplayTimeLabel(service.timeLabel)}`;
};

export const buildFellowshipSearchText = (
  fellowship: FellowshipVenueEntry,
  service?: FellowshipServiceEntry | null
): string => {
  const activeService = service ?? fellowship.services[0] ?? null;

  return [
    fellowship.code,
    fellowship.name,
    fellowship.contact ?? '',
    activeService?.dayLabel ?? '',
    activeService?.timeLabel ?? '',
    formatDisplayTimeLabel(activeService?.timeLabel ?? ''),
    activeService?.roomLabel ?? '',
    activeService?.infoLabel ?? '',
  ]
    .join(' ')
    .trim()
    .toLowerCase();
};
