import { useEffect, useRef } from 'react';
import L from 'leaflet';
import { useAppStore } from '../store/useAppStore';
import { subscribeLiveStatus } from '../services/firebase';
import { clientConfig } from '../config/client';

interface LiveStatusLayerProps {
  map: L.Map | null;
  campusId: string;
}

/**
 * LiveStatusLayer Component
 * 
 * Subscribes to Firestore live_status collection
 * - Updates marker colors based on real-time status
 * - Displays power levels and online/offline status
 * - Updates timestamps for last update
 * - Works in conjunction with MarkerLayer for visual updates
 */
export const LiveStatusLayer: React.FC<LiveStatusLayerProps> = ({
  map,
  campusId,
}) => {
  const unsubscribeRef = useRef<(() => void) | null>(null);
  const { updateLiveStatus } = useAppStore();

  useEffect(() => {
    if (!map || !clientConfig.features.powerStatus) return;

    // Subscribe to live status updates
    unsubscribeRef.current = subscribeLiveStatus(campusId, (statuses) => {
      // Update app store with live status data
      // This will trigger re-renders of components that use getLiveStatus()
      updateLiveStatus(statuses);

      // Log status updates for debugging
      statuses.forEach((status) => {
        console.log(`Updated status for ${status.location_id}: ${status.status}`);
      });
    });

    return () => {
      if (unsubscribeRef.current) {
        unsubscribeRef.current();
        unsubscribeRef.current = null;
      }
    };
  }, [map, campusId, updateLiveStatus]);

  return null; // This is a data layer, no UI rendering needed
};

export default LiveStatusLayer;
