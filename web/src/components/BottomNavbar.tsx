import { useEffect, useMemo, useState } from 'react';
import { useAppStore } from '../store/useAppStore';
import type { NotificationFeedEvent, StoredLocation } from '../store/useAppStore';
import { clientConfig } from '../config/client';
import { flyToUserLocationWithPopup } from '../core/mapLocation';
import { getGpsGuidance } from '../core/gpsStatus';
import { formatRelativeTime } from '../utils/dateTime';
import type { MapEngineAdapter } from '../core/mapEngineTypes';

interface BottomNavbarProps {
  mapInstance?: MapEngineAdapter | null;
}

type MobileMenuTab = 'favourite' | 'recent' | 'alerts';

/**
 * Persistent bottom navigation for primary map actions.
 */
export const BottomNavbar: React.FC<BottomNavbarProps> = ({ mapInstance }) => {
  const {
    selectedLocation,
    bottomSheetOpen,
    openBottomSheet,
    closeBottomSheet,
    deselectLocation,
    selectLocation,
    userLocation,
    gpsDiagnostics,
    gpsTrackingRequested,
    requestGpsAccess,
    setActiveFilters,
    favouriteLocations,
    recentLocations,
    notificationEvents,
    notificationFeedSeenAt,
    markNotificationFeedSeen,
    removeFavouriteLocation,
    clearRecentLocations,
  } = useAppStore();

  const [menuOpen, setMenuOpen] = useState(false);
  const [menuTab, setMenuTab] = useState<MobileMenuTab>('favourite');
  const [gpsHintDismissed, setGpsHintDismissed] = useState(false);

  const menuItems = useMemo(() => {
    if (menuTab === 'favourite') {
      return favouriteLocations.slice(0, 5);
    }

    return recentLocations.slice(0, 5);
  }, [favouriteLocations, menuTab, recentLocations]);
  const visibleNotificationEvents = useMemo(() => {
    const openableLocationIds = new Set([
      ...favouriteLocations.map((location) => location.id),
      ...recentLocations.map((location) => location.id),
    ]);

    return notificationEvents
      .filter((event) => openableLocationIds.has(event.locationId))
      .slice(0, 5);
  }, [favouriteLocations, notificationEvents, recentLocations]);
  const unreadNotificationCount = useMemo(() => {
    return notificationEvents.filter((event) => event.createdAt > notificationFeedSeenAt).length;
  }, [notificationEvents, notificationFeedSeenAt]);
  const hasUnreadAlerts = unreadNotificationCount > 0;

  const gpsGuidance = getGpsGuidance(gpsDiagnostics.status, gpsDiagnostics.errorMessage);

  useEffect(() => {
    setGpsHintDismissed(false);
  }, [gpsDiagnostics.status, gpsDiagnostics.errorMessage, gpsTrackingRequested]);

  const shouldShowGpsHint =
    !gpsHintDismissed &&
    gpsTrackingRequested &&
    gpsDiagnostics.status !== 'ready' &&
    gpsDiagnostics.status !== 'idle';

  const flyToCampus = (): void => {
    mapInstance?.flyTo(clientConfig.map.center, clientConfig.map.zoom, { duration: 0.6 });
  };

  const handleCampus = (): void => {
    setActiveFilters([]);
    closeBottomSheet();
    deselectLocation();
    setMenuOpen(false);
    flyToCampus();
  };

  const handleLocate = (): void => {
    setMenuOpen(false);

    if (mapInstance && userLocation) {
      flyToUserLocationWithPopup(mapInstance, userLocation, 17, 0.6);
      return;
    }

    requestGpsAccess();

    if (selectedLocation && !bottomSheetOpen) {
      openBottomSheet();
    }
  };

  const handleRetryGps = (): void => {
    requestGpsAccess();
  };

  const handleDismissGpsHint = (): void => {
    setGpsHintDismissed(true);
  };

  const handleDetails = (): void => {
    setMenuOpen(false);

    if (!selectedLocation) {
      return;
    }

    if (bottomSheetOpen) {
      closeBottomSheet();
      return;
    }

    openBottomSheet();
  };

  const handleToggleMenu = (): void => {
    closeBottomSheet();
    setMenuOpen((current) => !current);
  };

  const openMenuLocation = (location: StoredLocation): void => {
    selectLocation({
      id: location.id,
      name: location.name,
      type: location.type,
      coordinates: location.coordinates,
      properties: location.properties,
    });

    mapInstance?.flyTo(location.coordinates, 17, { duration: 0.65 });
    setMenuOpen(false);
  };

  const openMenuNotification = (event: NotificationFeedEvent): void => {
    const matchedFavourite = favouriteLocations.find((location) => location.id === event.locationId);
    const matchedRecent = recentLocations.find((location) => location.id === event.locationId);
    const matchedLocation = matchedFavourite ?? matchedRecent;

    if (!matchedLocation) {
      setMenuOpen(false);
      markNotificationFeedSeen();
      return;
    }

    selectLocation({
      id: matchedLocation.id,
      name: matchedLocation.name,
      type: matchedLocation.type,
      coordinates: matchedLocation.coordinates,
      properties: matchedLocation.properties,
    });

    mapInstance?.flyTo(matchedLocation.coordinates, 17, { duration: 0.65 });
    markNotificationFeedSeen();
    setMenuOpen(false);
  };

  useEffect(() => {
    if (menuOpen && menuTab === 'alerts') {
      markNotificationFeedSeen();
    }
  }, [markNotificationFeedSeen, menuOpen, menuTab]);

  return (
    <>
      {menuOpen && (
        <>
          <button
            type="button"
            aria-label="Close mobile menu"
            className="pointer-events-auto fixed inset-0 z-40 bg-slate-900/25 lg:hidden"
            onClick={() => setMenuOpen(false)}
          />

          <section className="pointer-events-auto fixed inset-x-3 bottom-[96px] z-50 max-h-[54vh] overflow-hidden rounded-[28px] border border-white/80 bg-white/95 shadow-[0_24px_56px_rgba(15,23,42,0.3)] backdrop-blur lg:hidden">
            <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3">
              <h3 className="font-['Outfit'] text-xl font-semibold text-slate-900">Quick places</h3>
              <button
                type="button"
                onClick={() => setMenuOpen(false)}
                className="panel-close-icon"
                aria-label="Close mobile menu"
              >
                <svg viewBox="0 0 24 24" className="h-4 w-4" aria-hidden="true">
                  <path d="M6 6 18 18M18 6 6 18" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" />
                </svg>
              </button>
            </div>

            <div className="border-b border-slate-200 px-4 py-2">
              <div className="grid grid-cols-3 gap-2">
                <button
                  type="button"
                  onClick={() => setMenuTab('favourite')}
                  className={`rounded-full border px-3 py-2 text-xs font-semibold uppercase tracking-wide transition ${menuTab === 'favourite'
                     ? 'border-cyan-500 bg-cyan-600 text-white'
                     : 'border-slate-300 bg-white text-slate-600'
                     }`}
                >
                  Favourite ({favouriteLocations.length})
                </button>

                <button
                  type="button"
                  onClick={() => setMenuTab('recent')}
                  className={`rounded-full border px-3 py-2 text-xs font-semibold uppercase tracking-wide transition ${menuTab === 'recent'
                    ? 'border-cyan-500 bg-cyan-600 text-white'
                    : 'border-slate-300 bg-white text-slate-600'
                    }`}
                >
                  Recent ({recentLocations.length})
                </button>

                <button
                  type="button"
                  onClick={() => setMenuTab('alerts')}
                  className={`rounded-full border px-3 py-2 text-xs font-semibold uppercase tracking-wide transition ${
                    menuTab === 'alerts'
                      ? 'border-cyan-500 bg-cyan-600 text-white'
                      : hasUnreadAlerts
                        ? 'alert-tab-attention border-cyan-300 bg-cyan-50 text-cyan-800'
                        : 'border-slate-300 bg-white text-slate-600'
                  }`}
                >
                  <span className="inline-flex items-center gap-1.5">
                    {hasUnreadAlerts && menuTab !== 'alerts' && (
                      <span className="alert-attention-dot" aria-hidden="true" />
                    )}
                    Alerts ({unreadNotificationCount})
                  </span>
                </button>
              </div>

              {menuTab === 'recent' && recentLocations.length > 0 && (
                <button
                  type="button"
                  onClick={clearRecentLocations}
                  className="mt-2 rounded-full border border-slate-300 px-3 py-1 text-[11px] font-semibold uppercase tracking-wide text-slate-600"
                >
                  Clear recent
                </button>
              )}
            </div>

            <div className="max-h-[38vh] space-y-2 overflow-y-auto px-4 py-3">
              {menuTab === 'alerts' ? (
                visibleNotificationEvents.length === 0 ? (
                  <p className="rounded-2xl border border-dashed border-slate-300 bg-slate-50 px-4 py-5 text-sm font-medium text-slate-500">
                    No missed alerts yet. Favourite a location to start tracking changes.
                  </p>
                ) : (
                  visibleNotificationEvents.map((event) => {
                    const isUnread = event.createdAt > notificationFeedSeenAt;

                    return (
                      <button
                        key={event.id}
                        type="button"
                        onClick={() => openMenuNotification(event)}
                        className={`w-full rounded-2xl border px-3 py-3 text-left ${
                          isUnread
                            ? 'border-cyan-200 bg-cyan-50/60'
                            : 'border-slate-200 bg-white'
                        }`}
                      >
                        <div className="flex items-start justify-between gap-3">
                          <div>
                            <p className="font-['Outfit'] text-lg font-semibold text-slate-900">
                              {event.locationName}
                            </p>
                            <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                              {event.module} - {formatRelativeTime(event.createdAt)}
                            </p>
                          </div>
                          {isUnread && (
                            <span className="rounded-full bg-cyan-600 px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-white">
                              New
                            </span>
                          )}
                        </div>
                        <p className="mt-2 text-sm font-medium text-slate-700">{event.body}</p>
                      </button>
                    );
                  })
                )
              ) : menuItems.length === 0 ? (
                <p className="rounded-2xl border border-dashed border-slate-300 bg-slate-50 px-4 py-5 text-sm font-medium text-slate-500">
                  {menuTab === 'favourite'
                    ? 'No favourite places yet. Open a location and tap Favourite.'
                    : 'No recent places yet. Search or tap a location on the map.'}
                </p>
              ) : (
                menuItems.map((location) => (
                  <div
                    key={`${menuTab}_${location.id}`}
                    className="flex items-start gap-3 rounded-2xl border border-slate-200 bg-white px-3 py-3"
                  >
                    <button
                      type="button"
                      onClick={() => openMenuLocation(location)}
                      className="flex-1 text-left"
                    >
                      <p className="font-['Outfit'] text-lg font-semibold text-slate-900">{location.name}</p>
                      <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                        {location.type} - {formatRelativeTime(location.timestamp)}
                      </p>
                    </button>

                    {menuTab === 'favourite' && (
                      <button
                        type="button"
                        onClick={() => removeFavouriteLocation(location.id)}
                        className="rounded-full border border-slate-300 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wide text-slate-600"
                      >
                        Remove
                      </button>
                    )}
                  </div>
                ))
              )}
            </div>
          </section>
        </>
      )}

      {shouldShowGpsHint && (
        <div className="pointer-events-none fixed inset-x-0 bottom-[154px] z-40 px-4 sm:bottom-[168px] lg:hidden">
          <div className="pointer-events-auto mx-auto max-w-[520px] rounded-2xl border border-amber-200 bg-amber-50 px-3 py-3 text-amber-900 shadow-[0_14px_30px_rgba(15,23,42,0.18)]">
            <div className="flex items-start justify-between gap-3">
              <p className="text-[11px] font-semibold uppercase tracking-[0.16em]">GPS alert</p>
              <button
                type="button"
                onClick={handleDismissGpsHint}
                aria-label="Dismiss GPS alert"
                className="rounded-full border border-amber-300 bg-white px-2 py-0.5 text-xs font-semibold text-amber-800"
              >
                x
              </button>
            </div>
            <p className="mt-1 text-sm font-semibold">{gpsGuidance.title}</p>
            <p className="mt-1 text-xs font-medium">{gpsGuidance.summary}</p>
            {gpsGuidance.canRetry && (
              <button
                type="button"
                onClick={handleRetryGps}
                className="mt-2 rounded-full border border-amber-300 bg-white px-3 py-1 text-[11px] font-semibold uppercase tracking-wide text-amber-800"
              >
                Retry GPS
              </button>
            )}
          </div>
        </div>
      )}
      <div className="pointer-events-none fixed inset-x-0 bottom-0 z-50 px-4 pb-4 lg:hidden">
        <nav className="bottom-nav-shell pointer-events-auto" aria-label="Primary map navigation">
          <button
            onClick={handleToggleMenu}
            className={`bottom-nav-item ${menuOpen ? 'bottom-nav-item-active' : ''} ${
              hasUnreadAlerts && !menuOpen ? 'bottom-nav-item-attention' : ''
            }`}
            type="button"
          >
            {hasUnreadAlerts && !menuOpen && (
              <span className="alert-bottom-nav-badge" aria-label={`${unreadNotificationCount} unread alerts`}>
                {Math.min(unreadNotificationCount, 9)}+
              </span>
            )}
            <span className="bottom-nav-label">Menu</span>
            <span className="bottom-nav-sub">
              {unreadNotificationCount > 0 ? `${unreadNotificationCount} new alerts` : 'Places & alerts'}
            </span>
          </button>

          <button onClick={handleCampus} className="bottom-nav-item" type="button">
            <span className="bottom-nav-label">Campus</span>
            <span className="bottom-nav-sub">Recenter</span>
          </button>

          <button onClick={handleLocate} className="bottom-nav-item" type="button">
            <span className="bottom-nav-label">Locate</span>
            <span className="bottom-nav-sub">{gpsGuidance.shortLabel}</span>
          </button>

          <button
            onClick={handleDetails}
            className={`bottom-nav-item ${selectedLocation && bottomSheetOpen ? 'bottom-nav-item-active' : ''}`}
            disabled={!selectedLocation}
            type="button"
          >
            <span className="bottom-nav-label">Details</span>
            <span className="bottom-nav-sub">Location</span>
          </button>
        </nav>
      </div>
    </>
  );
};

export default BottomNavbar;





