import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import { ApiError, isAbort } from "./api";

export type Resource<T> = {
  status: "loading" | "ready" | "error";
  data: T | null;
  error: ApiError | null;
  /** True while a manual refresh is in flight and `data` still holds the previous result. */
  refreshing: boolean;
  /** When the current `data` was received (browser clock, shown in UTC). */
  loadedAt: Date | null;
  reload: () => void;
};

type Internal<T> = Omit<Resource<T>, "reload">;

/**
 * Load one dataset. `key` identifies it: a new key discards the old data and shows the loading
 * state, `reload()` keeps the old data visible while refreshing. In-flight requests are aborted
 * on navigation and unmount, and a stale response can never overwrite a newer one.
 */
export function useResource<T>(
  key: string,
  load: (signal: AbortSignal) => Promise<T>,
): Resource<T> {
  const loader = useRef(load);
  loader.current = load;
  const [version, setVersion] = useState(0);
  const [state, setState] = useState<Internal<T> & { key: string }>({
    key,
    status: "loading",
    data: null,
    error: null,
    refreshing: false,
    loadedAt: null,
  });
  const lastKey = useRef(key);

  useEffect(() => {
    const controller = new AbortController();
    const changed = lastKey.current !== key;
    lastKey.current = key;
    setState((previous) =>
      changed || previous.data === null
        ? { key, status: "loading", data: null, error: null, refreshing: false, loadedAt: null }
        : { ...previous, key, refreshing: true },
    );
    loader
      .current(controller.signal)
      .then((data) => {
        if (controller.signal.aborted) return;
        setState({
          key,
          status: "ready",
          data,
          error: null,
          refreshing: false,
          loadedAt: new Date(),
        });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted || isAbort(error)) return;
        setState({
          key,
          status: "error",
          data: null,
          error: error instanceof ApiError ? error : new ApiError("server", 0),
          refreshing: false,
          loadedAt: null,
        });
      });
    return () => controller.abort();
  }, [key, version]);

  const reload = useCallback(() => setVersion((value) => value + 1), []);
  // Until the effect catches up with a key change, never show data that belongs to the old key.
  if (state.key !== key)
    return {
      status: "loading",
      data: null,
      error: null,
      refreshing: false,
      loadedAt: null,
      reload,
    };
  return { ...state, reload };
}

/** Cursor pagination as a stack of the cursors that led to the current page. */
export function useCursorPager(resetKey: string) {
  const [stack, setStack] = useState<{ key: string; cursors: (string | null)[] }>({
    key: resetKey,
    cursors: [null],
  });
  const cursors = stack.key === resetKey ? stack.cursors : [null];
  const cursor = cursors[cursors.length - 1] ?? null;
  return {
    cursor,
    page: cursors.length,
    hasPrevious: cursors.length > 1,
    next: (nextCursor: string) => setStack({ key: resetKey, cursors: [...cursors, nextCursor] }),
    previous: () => setStack({ key: resetKey, cursors: cursors.slice(0, -1) }),
  };
}
