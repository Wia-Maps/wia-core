/**
 * API Service Layer
 *
 * Handles external API calls and data fetching.
 */

export interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: string;
}

export interface LocationTrackingPayload {
  campus_id: string;
  latitude: number;
  longitude: number;
  accuracy_m: number;
  heading_deg: number | null;
  speed_mps: number | null;
  timestamp_ms: number;
}

const resolveLocationTrackingEndpoint = (): string | null => {
  const env = (import.meta as { env?: Record<string, string | undefined> }).env;
  const endpoint = env?.VITE_LOCATION_TRACKING_ENDPOINT?.trim();
  return endpoint && endpoint.length > 0 ? endpoint : null;
};

const LOCATION_TRACKING_ENDPOINT = resolveLocationTrackingEndpoint();

/**
 * Fetch GeoJSON data from a URL or local source.
 */
export const fetchGeoJSON = async (url: string): Promise<unknown> => {
  try {
    const response = await fetch(url);

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    return await response.json();
  } catch (error) {
    console.error('Error fetching GeoJSON:', error);
    throw error;
  }
};

/**
 * Sends live location updates when a tracking endpoint is configured.
 *
 * Set VITE_LOCATION_TRACKING_ENDPOINT to enable this.
 */
export const sendLocationUpdate = async (payload: LocationTrackingPayload): Promise<void> => {
  if (!LOCATION_TRACKING_ENDPOINT) {
    return;
  }

  const body = JSON.stringify(payload);

  try {
    if (typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function') {
      const sent = navigator.sendBeacon(
        LOCATION_TRACKING_ENDPOINT,
        new Blob([body], { type: 'application/json' })
      );

      if (sent) {
        return;
      }
    }

    await fetch(LOCATION_TRACKING_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body,
      keepalive: true,
    });
  } catch {
    // Ignore transient network failures for live location updates.
  }
};

/**
 * Placeholder for campus data synchronization.
 */
export const syncCampusData = async (): Promise<void> => {
  console.log('Campus data sync initiated');
  // Implementation would go here.
};
