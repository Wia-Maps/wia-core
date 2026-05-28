# Wia Architecture Guide

## Design Philosophy

Wia is built with **configuration-driven, reusable components** that scale across multiple campuses without code changes.

### Core Principles

1. **No Hardcoded Campus Data** - All campus-specific info lives in `clientConfig`
2. **Generic Components** - Components don't know about specific buildings or features
3. **Event-Driven** - Components communicate through the Zustand store, not props
4. **Offline-First** - All data cached, syncs when online
5. **Type-Safe** - Full TypeScript, strict mode enabled

## Layer Architecture

```
┌─────────────────────────────────────────┐
│         UI Layer (Components)            │
│  SearchBar, LocationInfoCard, Floating  │
├─────────────────────────────────────────┤
│         Data Layer (Zustand Store)       │
│  Global state: selections, live status  │
├─────────────────────────────────────────┤
│        Map Layer (Core Components)       │
│  MapEngine, GeoLayer, LiveStatusLayer   │
├─────────────────────────────────────────┤
│        Service Layer                     │
│  Firebase, API, Offline Sync             │
├─────────────────────────────────────────┤
│      Configuration & Static Data         │
│  clientConfig, sample.geojson            │
└─────────────────────────────────────────┘
```

## Component Deep Dive

### MapEngine
**Purpose**: Initialize and manage Leaflet map
**Responsibilities**:
- Create L.Map instance
- Center map from `clientConfig.map.center`
- Set zoom bounds from config
- Add tile layer
- Handle lifecycle cleanup

**Key Props**: `onMapReady`
**Returns**: null (map DOM is the container)

**Why it's generic**:
- No feature-specific code
- Uses only config values
- Can be reused for any campus

### GeoLayer
**Purpose**: Load and render GeoJSON features
**Responsibilities**:
- Fetch GeoJSON from URL
- Parse and validate
- Render each feature as polygon
- Handle click events
- Update visual state on hover
- Dispatch selections to store

**Key Props**: `map`, `geojsonUrl`
**Emits via Store**: `selectLocation()`

**Features**:
- Hover effects (weight, opacity)
- Click to select with location data
- Color from config: `theme.primary`
- Dynamic feature parsing

### LiveStatusLayer
**Purpose**: Subscribe to real-time Firestore data
**Responsibilities**:
- Initialize Firestore subscription
- Listen on `live_status` collection
- Map updates to store
- Create/update status markers on map
- Color-code by status
- Show power levels
- Display timestamps

**Key Props**: `map`, `campusId`
**Syncs with**: Zustand store's `liveStatusMap`

**Firestore Integration**:
```typescript
// Subscribes to:
collection(db, 'live_status')
  .where('campus_id', '==', campusId)
  .onSnapshot(...)
```

### Zustand Store
**Purpose**: Centralized global state
**Data Flow**:
```
GeoLayer 
  → selectLocation() 
  → store updates selectedLocation 
  → LocationInfoCard re-renders
```

**Key State**:
```typescript
{
  selectedLocation: SelectedLocation | null,
  bottomSheetOpen: boolean,
  liveStatusMap: Map<string, LiveStatus>,
  isOnline: boolean,
  pendingReports: PendingReport[],
}
```

**Why Map instead of object?**:
- O(1) lookup by locationId
- Immutable updates with Map constructor
- Type-safe

### LocationInfoCard
**Purpose**: Display selected location details
**Responsibilities**:
- Show location name and type
- Display live status if available
- Show features as badges
- Display metrics (floors, occupancy)
- Action buttons (directions, report)

**Props**: None (reads from store)
**Bottom Sheet**: Fixed overlay, 80vh max height

**Color System**:
- Uses `clientConfig.theme` colors
- Status colors map: online→success, offline→danger, maintenance→warning

## Configuration System

### clientConfig Structure
```typescript
{
  name: string,                  // Campus display name
  campus_id: string,             // Unique identifier
  
  map: {
    center: [lat, lng],          // Map center point
    zoom: number,                // Default zoom level
    minZoom: number,
    maxZoom: number,
  },
  
  theme: {
    primary: string,             // Brand color
    secondary: string,
    success: string,
    warning: string,
    danger: string,
    dark: string,
  },
  
  features: {
    powerStatus: boolean,        // Show power levels
    liveTracking: boolean,       // Subscribe to live data
    reporting: boolean,          // Enable reporting
    search: boolean,             // Enable search
  },
  
  offline: {
    enabled: boolean,            // Enable offline mode
    persistence: boolean,        // Persist data locally
  },
}
```

### Creating a Campus Config
```typescript
// For new campus, override in client.ts:
export const clientConfig = {
  name: "Harvard University",
  campus_id: "harvard-main",
  map: {
    center: [42.3643, -71.1199],  // Cambridge, MA
    zoom: 17,
  },
  theme: {
    primary: "#A41E34",  // Harvard crimson
  },
  // ... rest of config
};
```

**Then update**:
1. `src/data/sample.geojson` - Buildings for campus
2. Firestore `live_status` collection - Add campus_id matches

## Data Flow Diagram

### Selection Flow
```
User clicks polygon
    ↓
GeoLayer onClick event
    ↓
selectLocation(location) → store
    ↓
selectedLocation & bottomSheetOpen update
    ↓
LocationInfoCard re-renders with new data
```

### Live Status Flow
```
Firestore collection changes
    ↓
LiveStatusLayer subscription fires
    ↓
updateLiveStatus(statuses) → store
    ↓
liveStatusMap updates
    ↓
LocationInfoCard reads via getLiveStatus()
    ↓
UI re-renders with new status
```

### Offline Flow
```
User offline
    ↓
window.offline event
    ↓
setOnline(false) → store
    ↓
FloatingActions shows "Offline"
    ↓
Reporting module queues reports
    ↓
User comes online
    ↓
Service worker syncs data
    ↓
processPendingReports() sends queue
```

## GeoJSON Schema

Required structure for features:
```json
{
  "type": "Feature",
  "id": "building_001",        // Must be unique
  "geometry": {
    "type": "Polygon",
    "coordinates": [[...]]     // Must be valid polygon
  },
  "properties": {
    "name": "Engineering Hall",
    "type": "Academic",
    "campus_id": "wia-main",   // Must match config campus_id
    // ... additional properties used in LocationInfoCard
    "features": ["WiFi", "Elevator"],
    "floor_count": 4,
    "occupancy": 250
  }
}
```

## Firebase Schema

### live_status Collection
```
Document ID: feature.id from GeoJSON
{
  location_id: string,         // Matches GeoJSON feature.id
  campus_id: string,           // Matches clientConfig.campus_id
  status: "online" | "offline" | "maintenance",
  power_level: number,         // 0-100, optional
  last_updated: timestamp,     // Firebase server time
}
```

Example query in LiveStatusLayer:
```typescript
collection(db, 'live_status')
  .where('campus_id', '==', 'wia-main')  // From config
  .onSnapshot(snapshot => {
    // Updates as data changes
  });
```

## Offline Architecture

### Service Worker
- Caches HTML/CSS/JS on install
- Intercepts fetch requests
- Returns cache if available
- Falls back to network
- Updates cache on success

### Firestore Persistence
- IndexedDB backend configured
- Data synced to local db
- Transparently works offline
- Syncs when reconnected

### Report Queue
```typescript
// When offline:
addPendingReport({
  location_id: "building_001",
  type: "outage",
  description: "Power down",
})

// Store in memory + localStorage
// When online:
processPendingReports()
  → Send to backend
  → markReportSynced()
```

## Extension Points

### Add Custom Feature Module
```typescript
// src/modules/myfeature/index.ts
export const useMyFeature = () => {
  const { selectedLocation } = useAppStore();
  // Feature logic here
};
```

### Add Custom Layer
```typescript
// src/core/CustomLayer.tsx
export const CustomLayer: React.FC<{ map: L.Map }> = ({ map }) => {
  useEffect(() => {
    // Create layer logic
    // layer.addTo(map)
    return () => map.removeLayer(layer);
  }, [map]);
  return null;
};

// In App.tsx:
{map && <CustomLayer map={map} />}
```

### Add Custom UI Component
```typescript
// src/components/CustomWidget.tsx
export const CustomWidget: React.FC = () => {
  const { selectedLocation, isOnline } = useAppStore();
  // Component logic
  return <div>...</div>;
};

// In App.tsx:
<CustomWidget />
```

## Type Safety

### Creating Types
```typescript
// Extend SelectedLocation
interface LocationWithMetadata extends SelectedLocation {
  metadata: Record<string, any>;
}

// Extract store type
type AppStoreState = ReturnType<typeof useAppStore.getState>;
```

### Typing Props
```typescript
interface ComponentProps {
  map: L.Map | null;              // Leaflet type
  geojsonUrl: string;
  onFeatureLoaded?: (count: number) => void;
}
```

## Performance Considerations

1. **Lazy GeoJSON Loading** - Features fetched on demand, not bundled
2. **Map Debouncing** - Zoom/pan events debounced
3. **Store Subscriptions** - Components subscribe only to needed state
4. **List Virtualization** - Search results limited to 5
5. **CSS-in-JS Minimal** - Tailwind for styling efficiency

## Security

1. **No API Keys in Code** - Use `.env.local` (not committed)
2. **Firebase Rules** - Configure appropriately for your data
3. **HTTPS Only** - Service worker requires secure context
4. **Validate GeoJSON** - Server should validate if user-provided
5. **Sanitize User Input** - Reports and feedback should be cleaned

## Testing Strategy

### Unit Tests
```typescript
// Test store mutations
const { selectLocation } = useAppStore();
// Assert state changed
```

### Component Tests
```typescript
// Test MapEngine initialization
// Test GeoLayer parsing
// Test LocationInfoCard rendering
```

### Integration Tests
```typescript
// Test full flow: load GeoJSON → click → show details
```

### E2E Tests
```bash
# Playwright/Cypress for full user journeys
```

## Deployment Checklist

- [ ] Build succeeds: `npm run build`
- [ ] Type check passes: `npm run type-check`
- [ ] Firebase config in `.env` (or demo mode)
- [ ] Firestore collection created with correct schema
- [ ] GeoJSON valid at `/src/data/sample.geojson`
- [ ] Service worker path correct in `index.html`
- [ ] Manifest.json includes correct theme colors
- [ ] Serve over HTTPS
- [ ] Test offline mode
- [ ] Test live status updates
- [ ] Verify responsive on mobile

## Monitoring & Debugging

### Check Service Worker
DevTools → Application → Service Workers

### Check Firestore
Firebase Console → Firestore → Verify data

### Check Offline Cache
DevTools → Application → Storage → IndexedDB

### Logs
- Browser Console - App errors
- Firebase Console - Database activity
- Network tab - Asset caching
