export type GpsFixStatus =
  | 'idle'
  | 'checking'
  | 'ready'
  | 'unsupported'
  | 'permission-denied'
  | 'position-unavailable'
  | 'timeout'
  | 'error';

export type GpsPermissionState = 'unknown' | 'prompt' | 'granted' | 'denied';

export interface GpsDiagnostics {
  status: GpsFixStatus;
  permission: GpsPermissionState;
  errorMessage: string | null;
  lastUpdatedAt: number | null;
}

export interface GpsGuidance {
  title: string;
  summary: string;
  shortLabel: string;
  steps: string[];
  tone: 'neutral' | 'warning' | 'critical' | 'positive';
  canRetry: boolean;
}

export const toGpsPermissionState = (permission: PermissionState): GpsPermissionState => {
  if (permission === 'granted') {
    return 'granted';
  }

  if (permission === 'denied') {
    return 'denied';
  }

  return 'prompt';
};

export const gpsStatusFromErrorCode = (code: number): GpsFixStatus => {
  switch (code) {
    case 1:
      return 'permission-denied';
    case 2:
      return 'position-unavailable';
    case 3:
      return 'timeout';
    default:
      return 'error';
  }
};

export const getGpsGuidance = (status: GpsFixStatus, errorMessage: string | null): GpsGuidance => {
  const errorSuffix = errorMessage ? ` ${errorMessage}` : '';

  switch (status) {
    case 'ready':
      return {
        title: 'Location ready',
        summary: 'GPS is on and your live position is available.',
        shortLabel: 'GPS on',
        steps: [],
        tone: 'positive',
        canRetry: false,
      };
    case 'checking':
      return {
        title: 'Finding your location',
        summary: 'Allow location access in your browser prompt to continue.',
        shortLabel: 'Finding...',
        steps: [
          'Keep this tab open while your browser asks for location access.',
          'If prompted, choose Allow and enable precise location.',
        ],
        tone: 'neutral',
        canRetry: true,
      };
    case 'unsupported':
      return {
        title: 'Location not supported',
        summary: 'This browser does not provide GPS access for this app.',
        shortLabel: 'No GPS',
        steps: ['Open the app in a modern browser with location support.'],
        tone: 'critical',
        canRetry: false,
      };
    case 'permission-denied':
      return {
        title: 'Location permission is blocked',
        summary: `The app cannot read your position until permission is allowed.${errorSuffix}`,
        shortLabel: 'Permission off',
        steps: [
          'Open your browser site settings and allow Location for this site.',
          'Turn on precise or high-accuracy location in device settings.',
          'Return here and tap Retry GPS.',
        ],
        tone: 'critical',
        canRetry: true,
      };
    case 'position-unavailable':
      return {
        title: 'GPS signal is unavailable',
        summary: `Your device could not get a reliable location fix.${errorSuffix}`,
        shortLabel: 'GPS off',
        steps: [
          'Turn on device Location Services or GPS.',
          'Move to an open area or near a window for better signal.',
          'Tap Retry GPS after signal improves.',
        ],
        tone: 'warning',
        canRetry: true,
      };
    case 'timeout':
      return {
        title: 'Location request timed out',
        summary: `GPS did not respond quickly enough.${errorSuffix}`,
        shortLabel: 'Retry GPS',
        steps: [
          'Check that Location Services are still enabled.',
          'Improve signal strength and avoid indoor dead zones.',
          'Tap Retry GPS.',
        ],
        tone: 'warning',
        canRetry: true,
      };
    case 'error':
      return {
        title: 'Location issue detected',
        summary: `The app could not read GPS from this device.${errorSuffix}`,
        shortLabel: 'GPS issue',
        steps: [
          'Check browser location permission for this site.',
          'Confirm device Location Services are enabled.',
          'Tap Retry GPS.',
        ],
        tone: 'warning',
        canRetry: true,
      };
    case 'idle':
    default:
      return {
        title: 'Location access is off',
        summary: 'Turn on GPS to get routes from your current position.',
        shortLabel: 'Enable GPS',
        steps: [
          'Tap Start navigation or Locate to request location access.',
          'Allow location access when your browser prompts you.',
        ],
        tone: 'neutral',
        canRetry: true,
      };
  }
};
