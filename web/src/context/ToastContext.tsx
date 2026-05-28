import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  lazy,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { ReactNode } from 'react';
import { Suspense } from 'react';
import { ToastSkeleton } from '../components/LoadingPrimitives';

export type ToastTone = 'success' | 'warning' | 'error' | 'info';
export type ToastVisualStyle = 'default' | 'navigation-progress' | 'arrival-celebration';

export interface ToastStat {
  label: string;
  value: string;
}

export interface ToastInput {
  type: ToastTone;
  message: string;
  title?: string;
  durationMs?: number;
  dedupeKey?: string;
  once?: boolean;
  visualStyle?: ToastVisualStyle;
  stats?: ToastStat[];
}

export interface ToastRecord extends ToastInput {
  id: number;
}

interface ToastContextValue {
  showToast: (toast: ToastInput) => void;
  showSuccess: (message: string, options?: Omit<ToastInput, 'message' | 'type'>) => void;
  showWarning: (message: string, options?: Omit<ToastInput, 'message' | 'type'>) => void;
  showError: (message: string, options?: Omit<ToastInput, 'message' | 'type'>) => void;
  dismissToast: (id: number) => void;
}

const DEFAULT_DURATION_MS: Record<ToastTone, number> = {
  success: 3600,
  warning: 5200,
  error: 6200,
  info: 3200,
};

type ToastListener = (toast: ToastInput) => void;

const toastListeners = new Set<ToastListener>();
const pendingToasts: ToastInput[] = [];

const ToastViewport = lazy(() => import('./ToastViewport'));

export const publishToast = (toast: ToastInput): void => {
  if (toastListeners.size === 0) {
    pendingToasts.push(toast);
    return;
  }

  toastListeners.forEach((listener) => {
    listener(toast);
  });
};

const fallbackToastContextValue: ToastContextValue = {
  showToast: publishToast,
  showSuccess: (message, options) => {
    publishToast({
      ...options,
      type: 'success',
      message,
    });
  },
  showWarning: (message, options) => {
    publishToast({
      ...options,
      type: 'warning',
      message,
    });
  },
  showError: (message, options) => {
    publishToast({
      ...options,
      type: 'error',
      message,
    });
  },
  dismissToast: () => undefined,
};

const ToastContext = createContext<ToastContextValue | null>(fallbackToastContextValue);

export const ToastProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  const [toasts, setToasts] = useState<ToastRecord[]>([]);
  const nextToastIdRef = useRef(1);
  const timeoutIdsRef = useRef(new Map<number, number>());
  const recentToastRef = useRef(new Map<string, number>());

  const dismissToast = useCallback((id: number): void => {
    const timeoutId = timeoutIdsRef.current.get(id);

    if (timeoutId !== undefined) {
      window.clearTimeout(timeoutId);
      timeoutIdsRef.current.delete(id);
    }

    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  const showToast = useCallback(
    (toast: ToastInput): void => {
      const dedupeKey = toast.dedupeKey ?? `${toast.type}:${toast.title ?? ''}:${toast.message}`;
      const localStorageKey = `wia:toast:seen:${dedupeKey}`;

      // If this toast is marked `once`, persist its shown state in localStorage
      if (toast.once) {
        try {
          if (typeof window !== 'undefined' && window.localStorage) {
            const seen = window.localStorage.getItem(localStorageKey);
            if (seen === '1') {
              return; // already shown in a previous session
            }
          }
        } catch {
          // ignore storage errors
        }
      }
      const lastShownAt = recentToastRef.current.get(dedupeKey);
      const now = Date.now();

      if (lastShownAt && now - lastShownAt < 2500) {
        return;
      }

      recentToastRef.current.set(dedupeKey, now);

      const nextToast: ToastRecord = {
        ...toast,
        id: nextToastIdRef.current++,
      };

      setToasts((current) => [...current.slice(-3), nextToast]);

      const durationMs = toast.durationMs ?? DEFAULT_DURATION_MS[toast.type];
      const timeoutId = window.setTimeout(() => {
        dismissToast(nextToast.id);
      }, durationMs);

      timeoutIdsRef.current.set(nextToast.id, timeoutId);

      // Persist 'once' to localStorage after successfully queuing the toast
      if (toast.once) {
        try {
          if (typeof window !== 'undefined' && window.localStorage) {
            window.localStorage.setItem(localStorageKey, '1');
          }
        } catch {
          // ignore storage errors
        }
      }
    },
    [dismissToast]
  );

  useEffect(() => {
    toastListeners.add(showToast);

    while (pendingToasts.length > 0) {
      const nextToast = pendingToasts.shift();

      if (nextToast) {
        showToast(nextToast);
      }
    }

    return () => {
      toastListeners.delete(showToast);
    };
  }, [showToast]);

  useEffect(() => {
    return () => {
      timeoutIdsRef.current.forEach((timeoutId) => {
        window.clearTimeout(timeoutId);
      });
      timeoutIdsRef.current.clear();
    };
  }, []);

  const contextValue = useMemo<ToastContextValue>(() => {
    const buildTypedToast =
      (type: ToastTone) =>
      (message: string, options?: Omit<ToastInput, 'message' | 'type'>): void => {
        showToast({
          ...options,
          type,
          message,
        });
      };

    return {
      showToast,
      showSuccess: buildTypedToast('success'),
      showWarning: buildTypedToast('warning'),
      showError: buildTypedToast('error'),
      dismissToast,
    };
  }, [dismissToast, showToast]);

  return (
    <ToastContext.Provider value={contextValue}>
      {children}

      {toasts.length > 0 && (
        <Suspense fallback={<ToastSkeleton />}>
          <ToastViewport toasts={toasts} dismissToast={dismissToast} />
        </Suspense>
      )}
    </ToastContext.Provider>
  );
};

export const useToast = (): ToastContextValue => {
  const context = useContext(ToastContext);
  return context ?? fallbackToastContextValue;
};
