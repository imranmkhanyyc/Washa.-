export interface LatLng {
  lat: number;
  lng: number;
}

const R_KM = 6371.0088;
const rad = (d: number) => (d * Math.PI) / 180;

/** Straight-line (great-circle) distance in km. */
export function haversineKm(a: LatLng, b: LatLng): number {
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R_KM * Math.asin(Math.sqrt(h));
}

/** GeoJSON geometry (coordinates are [lng, lat]). */
export type GeoJsonPolygon =
  | { type: "Polygon"; coordinates: number[][][] }
  | { type: "MultiPolygon"; coordinates: number[][][][] };

function inRing(p: LatLng, ring: number[][]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i] as [number, number];
    const [xj, yj] = ring[j] as [number, number];
    const intersect = yi > p.lat !== yj > p.lat && p.lng < ((xj - xi) * (p.lat - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

function inPolygonRings(p: LatLng, rings: number[][][]): boolean {
  const [outer, ...holes] = rings;
  if (!outer || !inRing(p, outer)) return false;
  return !holes.some((h) => inRing(p, h));
}

export function pointInPolygon(p: LatLng, geom: GeoJsonPolygon): boolean {
  if (geom.type === "Polygon") return inPolygonRings(p, geom.coordinates);
  return geom.coordinates.some((poly) => inPolygonRings(p, poly));
}
