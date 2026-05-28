/**
 * Client Configuration
 * 
 * This configuration is designed to be reusable across multiple campus deployments.
 * Customize these values for each campus/tenant without modifying component logic.
 */

export const clientConfig = {
  // Campus/Client Identity
  name: "Wia Core",
  campus_id: "achievers-uni-owo",
  timezone: "Africa/Lagos",
  admin: {
    workspaceTitle: "Admin workspace",
    workspaceDescription: "Manage operations, live status updates, and map datasets.",
  },
  
  // Map Configuration
  map: {
    center: [7.1646, 
5.5839] as [number, number], // Default map center coordinates
    zoom: 16,
    minZoom: 13,
    maxZoom: 19,
    viewModeDefault: 'flat' as const,
    pitch: 58,
    bearing: -20,
    minPitch: 0,
    maxPitch: 60,
    metersPerFloor: 4,
    lowRiseBoostMaxFloors: 4,
    lowRiseBoostMaxMultiplier: 1.42,
    structureFallbackHeightM: 5,
    surfaceSlabHeightM: 0.3,
    realismZoomThreshold: 16.4,
    rasterTileUrls: [
      'https://a.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}.png',
      'https://b.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}.png',
      'https://c.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}.png',
      'https://d.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}.png',
    ],
  },
  
  // Theme Configuration
  theme: {
    primary: "#004aad",
    secondary: "#0066e6",
    success: "#10b981",
    warning: "#f59e0b",
    danger: "#ef4444",
    dark: "#1f2937",
  },
  
  // Feature Flags
  features: {
    powerStatus: true,
    liveTracking: true,
    reporting: true,
    search: true,
  },
  
  // Offline Configuration
  offline: {
    enabled: true,
    persistence: true,
  },
} as const;

export type ClientConfig = typeof clientConfig;
