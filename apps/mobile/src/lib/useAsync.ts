import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError } from './api/client';

interface AsyncState<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
}

/**
 * Mirrors apps/portal/src/lib/useAsync.ts — standardizes the load/error/retry
 * shape every screen needs when it fetches from the API on mount. The
 * "latest callback in a ref" pattern below (`fetcherRef.current = fetcher`
 * written during render) is exactly what it is upstream too; this app's
 * `eslint-config-expo` ships two new React-Compiler-oriented lint rules
 * (`react-hooks/refs`, `react-hooks/set-state-in-effect`) stricter than
 * anything apps/portal's `next/core-web-vitals` config checks, that flag
 * this well-established pattern (and the equivalent conditional
 * `setState` calls in ../lib/session/SessionContext.tsx's effects) as
 * unsafe under React Compiler's stricter assumptions. Both are turned off
 * in .eslintrc.json for this workspace rather than restructured — see
 * that file; this app doesn't use the React Compiler. A third
 * (`react-hooks/use-memo`) is also off: it requires every `useCallback`
 * dependency array to be a literal `[...]`, which is structurally
 * incompatible with this hook's whole purpose (forwarding a caller-
 * supplied `deps` array through to `useCallback`) — the same "generic
 * hook forwards its own deps array" shape used throughout the React
 * ecosystem (e.g. `usehooks-ts`'s `useDebounce`).
 */
export function useAsync<T>(fetcher: () => Promise<T>, deps: unknown[]): AsyncState<T> & { reload: () => void } {
  const [state, setState] = useState<AsyncState<T>>({ data: null, loading: true, error: null });
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  const load = useCallback(() => {
    let cancelled = false;
    setState((s) => ({ ...s, loading: true, error: null }));
    fetcherRef
      .current()
      .then((data) => {
        if (!cancelled) setState({ data, loading: false, error: null });
      })
      .catch((err) => {
        if (cancelled) return;
        const message = err instanceof ApiError ? err.message : 'Something went wrong.';
        setState({ data: null, loading: false, error: message });
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  useEffect(() => load(), [load]);

  return { ...state, reload: load };
}
