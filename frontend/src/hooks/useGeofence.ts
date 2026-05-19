import { useState, useEffect, useRef, useCallback } from 'react';

// Haversine Formula — returns distance in meters between two GPS coordinates
function haversine(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371e3;
  const φ1 = (lat1 * Math.PI) / 180;
  const φ2 = (lat2 * Math.PI) / 180;
  const Δφ = ((lat2 - lat1) * Math.PI) / 180;
  const Δλ = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(Δφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Fallback defaults (used until backend config is loaded)
export const GEOFENCE_TARGET = {
  lat: 16.4257442,
  lon: 102.8318782,
  name: 'AACC',
};
export const GEOFENCE_RADIUS_M = 100;

export type GeoStatus = 'idle' | 'requesting' | 'granted' | 'denied' | 'unavailable';

export interface GeofenceState {
  status: GeoStatus;
  distance: number | null;   // meters, rounded
  accuracy: number | null;   // GPS accuracy in meters
  userLat: number | null;    // raw lat — sent to server for re-validation
  userLon: number | null;    // raw lon — sent to server for re-validation
  isWithinRadius: boolean;
  start: () => void;
}

// MIN_DELTA_M: only trigger a React re-render when distance changes > 1 m
// This prevents rapid GPS updates from hammering the render cycle.
const MIN_DELTA_M = 1;

export function useGeofence(): GeofenceState {
  const [status, setStatus] = useState<GeoStatus>('idle');
  const [distance, setDistance] = useState<number | null>(null);
  const [accuracy, setAccuracy] = useState<number | null>(null);
  const [userLat, setUserLat] = useState<number | null>(null);
  const [userLon, setUserLon] = useState<number | null>(null);
  const [radiusM, setRadiusM] = useState(GEOFENCE_RADIUS_M);
  // Ref mirrors target so watchPosition callback always sees latest values
  const targetRef = useRef({ lat: GEOFENCE_TARGET.lat, lon: GEOFENCE_TARGET.lon });

  // Fetch geofence config from backend on mount
  useEffect(() => {
    fetch('/api/geofence')
      .then(r => r.json())
      .then(d => {
        targetRef.current = { lat: d.lat, lon: d.lon };
        setRadiusM(d.radius);
      })
      .catch(() => {});
  }, []);

  // watchId lives in a ref — changing it must NOT trigger re-renders
  const watchIdRef = useRef<number | null>(null);
  // Track last reported distance to apply MIN_DELTA_M throttle
  const lastDistanceRef = useRef<number | null>(null);

  const start = useCallback(() => {
    if (!navigator.geolocation) {
      setStatus('unavailable');
      return;
    }
    if (watchIdRef.current !== null) return; // already watching

    setStatus('requesting');

    watchIdRef.current = navigator.geolocation.watchPosition(
      (pos) => {
        const d = haversine(
          pos.coords.latitude,
          pos.coords.longitude,
          targetRef.current.lat,
          targetRef.current.lon,
        );
        const rounded = Math.round(d);

        // Throttle: skip setState if change is below threshold
        if (
          lastDistanceRef.current !== null &&
          Math.abs(rounded - lastDistanceRef.current) < MIN_DELTA_M
        ) {
          return;
        }

        lastDistanceRef.current = rounded;
        setDistance(rounded);
        setAccuracy(Math.round(pos.coords.accuracy));
        setUserLat(pos.coords.latitude);
        setUserLon(pos.coords.longitude);
        setStatus('granted');
      },
      (err) => {
        if (err.code === GeolocationPositionError.PERMISSION_DENIED) {
          setStatus('denied');
        } else {
          setStatus('unavailable');
        }
      },
      { enableHighAccuracy: true, timeout: 15_000, maximumAge: 0 },
    );
  }, []);

  // Cleanup the watch on unmount — critical to avoid memory leaks
  useEffect(() => {
    return () => {
      if (watchIdRef.current !== null) {
        navigator.geolocation.clearWatch(watchIdRef.current);
        watchIdRef.current = null;
      }
    };
  }, []);

  return {
    status,
    distance,
    accuracy,
    userLat,
    userLon,
    isWithinRadius: distance !== null && distance <= radiusM,
    start,
  };
}
