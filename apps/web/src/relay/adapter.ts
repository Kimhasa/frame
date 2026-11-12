// The real ViewerAdapter: the existing relay on the page's own origin (apps/api, the Spring Boot backend; server/relay.mjs is its Node
// comparison baseline; in development the Vite proxy).
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import type { BroadcastKey, ViewerAdapter, WatchView } from '../viewer-contract';
import { LiveList } from './live';
import { installRuntime } from './runtime';
import { WatchController } from './watch';

installRuntime();

function useLive() {
  const [list] = useState(() => new LiveList());
  useEffect(() => {
    list.start();
    return () => list.stop();
  }, [list]);
  const state = useSyncExternalStore(list.subscribe, list.getSnapshot, list.getSnapshot);
  return { state, retry: list.retry };
}

function useWatch(key: BroadcastKey): WatchView {
  const { path, id } = key;
  // One controller per broadcast link; a new link gets a new controller (and the old one is stopped by its effect).
  const controller = useMemo(() => new WatchController({ path, id }), [path, id]);
  useEffect(() => {
    controller.start();
    return () => controller.stop();
  }, [controller]);
  return useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
}

export const relayViewer: ViewerAdapter = { useLive, useWatch };
