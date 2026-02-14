/// <reference types="vite/client" />

declare const __APP_VERSION__: string;
declare const __APP_HASH__: string;

/** Debug utilities exposed on window (localhost only) */
interface Window {
  __hypatia?: Record<string, unknown>;
  __omCache?: {
    clearCache: () => Promise<boolean>;
    clearParamCache: (param: string) => Promise<boolean>;
    getCacheStats: () => Promise<unknown>;
    getParamStats: (param: string) => Promise<unknown>;
    clearOlderThan: (days: number) => Promise<number>;
    unregister: () => Promise<void>;
    prefetch: () => Promise<void>;
    prefetchHistory: () => Promise<unknown[]>;
    clearPrefetchHistory: () => Promise<boolean>;
    help: () => void;
  };
}
