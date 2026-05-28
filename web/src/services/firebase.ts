import { 
  initializeApp, 
  FirebaseApp 
} from 'firebase/app';
import { 
  Firestore,
  collection,
  query,
  where,
  onSnapshot,
  QueryConstraint,
  enableIndexedDbPersistence,
  initializeFirestore,
} from 'firebase/firestore';
import { clientConfig } from '../config/client';
import { publishToast } from '../context/ToastContext';
import type { LiveStatus as StoreLiveStatus } from '../store/useAppStore';

/**
 * Firebase Configuration
 * 
 * IMPORTANT: Replace with your actual Firebase config
 * Get this from Firebase Console: Project Settings
 */
const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY || 'demo-key',
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN || 'demo.firebaseapp.com',
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID || 'demo-project',
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET || 'demo.appspot.com',
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID || '123456789',
  appId: import.meta.env.VITE_FIREBASE_APP_ID || 'demo-app-id',
};

let app: FirebaseApp | null = null;
let db: Firestore | null = null;

/**
 * Initialize Firebase with offline persistence
 */
export const initializeFirebase = async (): Promise<Firestore> => {
  if (db) return db;
  
  try {
    const persistenceEnabled = clientConfig.offline.enabled && clientConfig.offline.persistence;

    // Initialize app
    app = initializeApp(firebaseConfig);
    
    db = persistenceEnabled
      ? initializeFirestore(app, {
          localCache: {
            kind: 'persistent',
          },
        })
      : initializeFirestore(app, {});
    
    if (!persistenceEnabled) {
      return db;
    }

    // Try to enable persistence on web (will fail if already enabled)
    try {
      await enableIndexedDbPersistence(db);
    } catch (err) {
      const error = err as { code?: string };
      if (error.code === 'failed-precondition') {
        // eslint-disable-next-line no-console
        console.warn('Multiple tabs open, persistence can only be enabled in one tab');
        publishToast({
          type: 'warning',
          title: 'Offline sync',
          message: 'Offline sync is limited because this app is already open in another tab.',
          dedupeKey: 'firebase-persistence-multi-tab',
        });
      } else if (error.code === 'unimplemented') {
        // eslint-disable-next-line no-console
        console.warn('Current browser does not support offline persistence');
        publishToast({
          type: 'warning',
          title: 'Offline sync',
          message: 'Offline sync is not supported in this browser.',
          dedupeKey: 'firebase-persistence-unimplemented',
        });
      }
    }
    
    return db;
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error('Firebase initialization error:', error);
    throw error;
  }
};

/**
 * Get Firestore instance (must call initializeFirebase first)
 */
export const getDb = (): Firestore => {
  if (!db) {
    throw new Error('Firebase not initialized. Call initializeFirebase first.');
  }
  return db;
};

const normalizeStatusValue = (value: unknown): StoreLiveStatus['status'] => {
  return value === 'online' || value === 'maintenance' ? value : 'offline';
};

const normalizeTimestamp = (value: unknown): number => {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }

  if (value instanceof Date) {
    return value.getTime();
  }

  if (
    value &&
    typeof value === 'object' &&
    'toMillis' in value &&
    typeof value.toMillis === 'function'
  ) {
    return value.toMillis();
  }

  return Date.now();
};

/**
 * Subscribe to live status updates for a campus
 * 
 * @param campusId - Campus identifier
 * @param onUpdate - Callback function with status array
 * @returns Unsubscribe function
 */
export const subscribeLiveStatus = (
  campusId: string,
  onUpdate: (statuses: StoreLiveStatus[]) => void
): (() => void) => {
  const db = getDb();
  const liveStatusRef = collection(db, 'live_status');
  
  const constraints: QueryConstraint[] = [
    where('campus_id', '==', campusId),
  ];
  
  const q = query(liveStatusRef, ...constraints);
  
  const unsubscribe = onSnapshot(
    q,
    (snapshot) => {
      const statuses = snapshot.docs.map((doc) => {
        const data = doc.data() as Record<string, unknown>;
        const rawPowerLevel = data.power_level;

        return {
          location_id: doc.id,
          status: normalizeStatusValue(data.status),
          power_level: typeof rawPowerLevel === 'number' ? rawPowerLevel : undefined,
          last_updated: normalizeTimestamp(data.last_updated),
        };
      });
      onUpdate(statuses);
    },
    (error) => {
      // eslint-disable-next-line no-console
      console.error('Error subscribing to live status:', error);
      publishToast({
        type: 'error',
        title: 'Live status',
        message: 'Live campus status updates are temporarily unavailable.',
        dedupeKey: 'firebase-live-status-subscription',
      });
    }
  );
  
  return unsubscribe;
};

/**
 * Submit a report (placeholder for write logic)
 * In a real implementation, this would write to Firestore
 * 
 * @param report - Report data
 * @returns Promise<void>
 */
export const submitReport = async (report: {
  location_id: string;
  type: string;
  description: string;
  campus_id: string;
}): Promise<void> => {
  // Placeholder: actual Firestore write logic would go here
  // eslint-disable-next-line no-console
  console.log('Report submitted:', report);
  return Promise.resolve();
};
