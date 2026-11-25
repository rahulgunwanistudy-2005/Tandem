import { useEffect, useState, useSyncExternalStore } from "react";
import { onAuthStateChanged, type User } from "firebase/auth";
import { firebase } from "../firebase.js";
import { Repo } from "../data/repo.js";

let repo: Repo | undefined;
export const useRepo = (): Repo => (repo ??= new Repo(firebase().db));

export function useUser(): User | null | undefined {
  const [user, setUser] = useState<User | null | undefined>(undefined);
  useEffect(() => onAuthStateChanged(firebase().auth, setUser), []);
  return user;
}

/** Subscribe to a Firestore listener for the lifetime of `deps`. undefined = loading. */
export function useLive<T>(
  subscribe: ((cb: (v: T) => void) => () => void) | undefined,
  deps: unknown[],
): T | undefined {
  const [value, setValue] = useState<T | undefined>(undefined);
  useEffect(() => {
    setValue(undefined);
    if (!subscribe) return;
    return subscribe(setValue);
  }, deps);
  return value;
}

// ---------- hash router ----------
const subscribeHash = (cb: () => void) => {
  window.addEventListener("hashchange", cb);
  return () => window.removeEventListener("hashchange", cb);
};
export function useRoute(): string[] {
  const hash = useSyncExternalStore(subscribeHash, () => window.location.hash);
  return hash.replace(/^#\/?/, "").split("/").filter(Boolean).map(decodeURIComponent);
}
export const href = (...parts: string[]) => `#/${parts.map(encodeURIComponent).join("/")}`;
export const go = (...parts: string[]) => {
  window.location.hash = href(...parts);
};

export function timeAgo(ms: number | undefined, now = Date.now()): string {
  if (ms === undefined) return "just now";
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return new Date(ms).toLocaleDateString();
}

export const pct = (x: number, digits = 0) => `${(x * 100).toFixed(digits)}%`;
export const ms = (x: number | undefined) =>
  x === undefined ? "—" : x >= 1000 ? `${(x / 1000).toFixed(x >= 10000 ? 0 : 1)} s` : `${Math.round(x)} ms`;
