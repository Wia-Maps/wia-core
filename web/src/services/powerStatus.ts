import { resolveSocketUrl, toApiUrl } from '../config/api';

export interface PowerSignalRecord {
  _id: string;
  locationId: string;
  powerStatus: boolean;
  reportedAt: string;
  reportedBy?: string | null;
}

export interface PowerSignalReportInput {
  locationId: string;
  powerStatus: boolean;
  reportedBy?: string;
  note?: string;
}

interface ApiResponse<T> {
  success: boolean;
  data: T;
  error?: string;
}

interface PowerSocketEnvelope {
  type?: string;
  data?: unknown;
}

const isPowerSignalRecord = (value: unknown): value is PowerSignalRecord => {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const candidate = value as Partial<PowerSignalRecord>;

  return (
    typeof candidate._id === 'string' &&
    typeof candidate.locationId === 'string' &&
    typeof candidate.powerStatus === 'boolean' &&
    typeof candidate.reportedAt === 'string'
  );
};

const readApiResponse = async <T>(response: Response): Promise<ApiResponse<T>> => {
  const payload = (await response.json()) as ApiResponse<T>;

  if (!response.ok || !payload.success) {
    throw new Error(payload.error || 'Request failed');
  }

  return payload;
};

export const fetchRecentPowerSignals = async (limit = 100): Promise<PowerSignalRecord[]> => {
  const response = await fetch(toApiUrl(`/power/recent?limit=${limit}`), {
    credentials: 'include',
  });
  const payload = await readApiResponse<PowerSignalRecord[]>(response);

  return Array.isArray(payload.data) ? payload.data.filter(isPowerSignalRecord) : [];
};

export const fetchLocationPowerSignal = async (locationId: string): Promise<PowerSignalRecord | null> => {
  const response = await fetch(toApiUrl(`/power/${encodeURIComponent(locationId)}`), {
    credentials: 'include',
  });

  if (response.status === 404) {
    return null;
  }

  const payload = await readApiResponse<PowerSignalRecord>(response);
  return isPowerSignalRecord(payload.data) ? payload.data : null;
};

export const reportLocationPowerStatus = async (
  payload: PowerSignalReportInput
): Promise<PowerSignalRecord> => {
  const response = await fetch(toApiUrl('/power/report'), {
    method: 'POST',
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  const result = await readApiResponse<PowerSignalRecord>(response);
  if (!isPowerSignalRecord(result.data)) {
    throw new Error('The power update response was invalid.');
  }

  return result.data;
};

interface PowerSignalSocketOptions {
  onReport: (report: PowerSignalRecord) => void;
  onClose?: () => void;
  onError?: (event: Event) => void;
  onOpen?: () => void;
}

export const subscribeToPowerSignals = ({
  onReport,
  onClose,
  onError,
  onOpen,
}: PowerSignalSocketOptions): WebSocket => {
  const socket = new WebSocket(resolveSocketUrl('/ws/power'));

  socket.addEventListener('open', () => {
    onOpen?.();
  });

  socket.addEventListener('message', (event) => {
    try {
      const payload = JSON.parse(event.data) as PowerSocketEnvelope;

      if (payload.type !== 'power:update' || !isPowerSignalRecord(payload.data)) {
        return;
      }

      onReport(payload.data);
    } catch {
      // Ignore invalid socket payloads.
    }
  });

  socket.addEventListener('close', () => {
    onClose?.();
  });

  socket.addEventListener('error', (event) => {
    onError?.(event);
  });

  return socket;
};
