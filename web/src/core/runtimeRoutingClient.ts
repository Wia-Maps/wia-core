import type {
  BuildExactRouteRequest,
  PrepareRuntimeRoutingRequest,
  PrepareRuntimeRoutingResult,
  RuntimeRoutingWorkerRequest,
  RuntimeRoutingWorkerResponse,
} from './runtimeRoutingTypes';
import type { RoutePreview } from '../store/useAppStore';

type PendingRequest =
  | {
      kind: 'prepare';
      resolve: (value: PrepareRuntimeRoutingResult) => void;
      reject: (reason?: unknown) => void;
    }
  | {
      kind: 'route';
      cacheKey: string;
      resolve: (value: RoutePreview) => void;
      reject: (reason?: unknown) => void;
    };

const ROUTE_CACHE_LIMIT = 60;
const CACHED_ROUTE_REQUEST_ID_BASE = -1000000;

const cloneRoutePreview = (preview: RoutePreview): RoutePreview => {
  if (typeof structuredClone === 'function') {
    return structuredClone(preview);
  }

  return JSON.parse(JSON.stringify(preview)) as RoutePreview;
};

const roundedCoordinate = (coordinate: [number, number]): string => {
  return `${coordinate[0].toFixed(4)},${coordinate[1].toFixed(4)}`;
};

const buildRouteCacheKey = (input: Omit<BuildExactRouteRequest, 'type' | 'requestId'>): string => {
  return [
    input.destinationId,
    input.accessibilityMode,
    input.originLocationId ?? '',
    roundedCoordinate(input.origin),
    roundedCoordinate(input.destination),
  ].join('|');
};

class RuntimeRoutingClient {
  private worker: Worker | null = null;

  private nextRequestId = 1;

  private nextCachedRequestId = CACHED_ROUTE_REQUEST_ID_BASE;

  private pending = new Map<number, PendingRequest>();

  private routeCache = new Map<string, RoutePreview>();

  private rememberRoute(cacheKey: string, preview: RoutePreview): void {
    if (this.routeCache.has(cacheKey)) {
      this.routeCache.delete(cacheKey);
    }

    this.routeCache.set(cacheKey, cloneRoutePreview(preview));

    while (this.routeCache.size > ROUTE_CACHE_LIMIT) {
      const oldestKey = this.routeCache.keys().next().value;
      if (!oldestKey) {
        break;
      }
      this.routeCache.delete(oldestKey);
    }
  }

  private ensureWorker(): Worker {
    if (this.worker) {
      return this.worker;
    }

    const worker = new Worker(new URL('./runtimeRoutingWorker.ts', import.meta.url), {
      type: 'module',
    });

    worker.onmessage = (event: MessageEvent<RuntimeRoutingWorkerResponse>) => {
      const message = event.data;
      const pendingRequest = this.pending.get(message.requestId);

      if (!pendingRequest) {
        return;
      }

      this.pending.delete(message.requestId);

      if (message.type === 'runtimeReady' && pendingRequest.kind === 'prepare') {
        pendingRequest.resolve(message.result);
        return;
      }

      if (message.type === 'routeReady' && pendingRequest.kind === 'route') {
        this.rememberRoute(pendingRequest.cacheKey, message.preview);
        pendingRequest.resolve(message.preview);
        return;
      }

      if (message.type === 'runtimeError') {
        pendingRequest.reject(new Error(message.message));
        return;
      }

      pendingRequest.reject(new Error('Routing worker returned an unexpected response.'));
    };

    worker.onerror = (event) => {
      const message = event.message || 'Routing worker crashed.';
      this.failAllPending(new Error(message));
      worker.terminate();
      this.worker = null;
    };

    this.worker = worker;
    return worker;
  }

  private failAllPending(error: Error): void {
    const pendingRequests = [...this.pending.values()];
    this.pending.clear();
    pendingRequests.forEach((entry) => {
      entry.reject(error);
    });
  }

  prepareRuntime(input: Omit<PrepareRuntimeRoutingRequest, 'type' | 'requestId'>): Promise<PrepareRuntimeRoutingResult> {
    const requestId = this.nextRequestId++;
    const worker = this.ensureWorker();
    this.routeCache.clear();

    return new Promise((resolve, reject) => {
      this.pending.set(requestId, {
        kind: 'prepare',
        resolve,
        reject,
      });

      worker.postMessage({
        type: 'prepareRuntimeRouting',
        requestId,
        ...input,
      } satisfies RuntimeRoutingWorkerRequest);
    });
  }

  buildExactRoute(input: Omit<BuildExactRouteRequest, 'type' | 'requestId'>): {
    requestId: number;
    promise: Promise<RoutePreview>;
  } {
    const cacheKey = buildRouteCacheKey(input);
    const cachedPreview = this.routeCache.get(cacheKey);
    if (cachedPreview) {
      const requestId = this.nextCachedRequestId--;
      return {
        requestId,
        promise: Promise.resolve(cloneRoutePreview(cachedPreview)),
      };
    }

    const requestId = this.nextRequestId++;
    const worker = this.ensureWorker();
    const promise = new Promise<RoutePreview>((resolve, reject) => {
      this.pending.set(requestId, {
        kind: 'route',
        cacheKey,
        resolve,
        reject,
      });

      worker.postMessage({
        type: 'buildExactRoute',
        requestId,
        ...input,
      } satisfies RuntimeRoutingWorkerRequest);
    });

    return {
      requestId,
      promise,
    };
  }

  cancelRoute(requestId: number): void {
    if (requestId < 0) {
      return;
    }

    this.pending.delete(requestId);
    this.worker?.postMessage({
      type: 'cancelRoute',
      requestId,
    } satisfies RuntimeRoutingWorkerRequest);
  }
}

export const runtimeRoutingClient = new RuntimeRoutingClient();
