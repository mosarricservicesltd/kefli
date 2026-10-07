// Connectivity (mobile spec 4): online unless the phone says it has no connection. useOffline holds a change to
// offline for a moment first, so a blip doesn't flash the notice (5.6: Saves' notice after a 1 s hold).
import { useEffect, useState } from 'react';
import { useNetworkState } from 'expo-network';

export function useOnline(): boolean {
  const n = useNetworkState();
  if (n.isConnected === false) return false;
  return n.isInternetReachable !== false;
}

export function useOffline(holdMs = 1000): boolean {
  const online = useOnline();
  const [held, setHeld] = useState(false);
  useEffect(() => {
    if (online) return setHeld(false);
    const t = setTimeout(() => setHeld(true), holdMs);
    return () => clearTimeout(t);
  }, [online, holdMs]);
  return held;
}
