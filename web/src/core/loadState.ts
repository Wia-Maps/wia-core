export type LoadState = 'idle' | 'loading' | 'processing' | 'ready' | 'error';

export const isLoadPending = (state: LoadState): boolean => {
  return state === 'idle' || state === 'loading' || state === 'processing';
};
