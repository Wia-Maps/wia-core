import { toApiUrl } from '../config/api';
import type { FellowshipBrandRecord } from '../core/fellowshipUtils';

interface ApiEnvelope<T> {
  success: boolean;
  data?: T;
  error?: string;
}

export const fetchPublicFellowshipBrands = async (): Promise<FellowshipBrandRecord[]> => {
  const response = await fetch(toApiUrl('/locations/fellowship-brands'), {
    method: 'GET',
    credentials: 'include',
  });

  const payload = (await response.json().catch(() => null)) as ApiEnvelope<FellowshipBrandRecord[]> | null;

  if (!response.ok || !payload?.success || !Array.isArray(payload.data)) {
    throw new Error(payload?.error || `Request failed with status ${response.status}`);
  }

  return payload.data;
};
