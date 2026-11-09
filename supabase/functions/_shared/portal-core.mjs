const encoder = new TextEncoder();
export function bytesToHex(bytes) { return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join(''); }
export function bytea(bytes) { return `\\x${bytesToHex(bytes)}`; }
export function fromBytea(value) {
  if (value instanceof Uint8Array) return value;
  const hex = String(value || '').replace(/^\\x/i, '').replace(/^0x/i, '');
  if (!/^(?:[0-9a-f]{2})+$/i.test(hex)) throw new Error('invalid bytea');
  return Uint8Array.from(hex.match(/.{2}/g), pair => parseInt(pair, 16));
}
export function toBase64Url(bytes) {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}
export function fromBase64Url(token) {
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) throw new Error('invalid token');
  const base64 = token.replace(/-/g, '+').replace(/_/g, '/') + '=';
  const binary = atob(base64);
  if (binary.length !== 32) throw new Error('invalid token');
  return Uint8Array.from(binary, c => c.charCodeAt(0));
}
export async function sha256(bytes) { return new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)); }
export async function deriveToken(secret, version, deliveryId, nonce) {
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const nonceBytes = nonce instanceof Uint8Array ? nonce : fromBytea(nonce);
  if (nonceBytes.length !== 32) throw new Error('invalid nonce');
  const message = encoder.encode(`tresor-delivery:v${version}:${deliveryId}:${toBase64Url(nonceBytes)}`);
  const tokenBytes = new Uint8Array(await crypto.subtle.sign('HMAC', key, message));
  return { token: toBase64Url(tokenBytes), tokenHash: bytea(await sha256(tokenBytes)), nonce: bytea(nonceBytes) };
}
export async function tokenHash(token) { return bytea(await sha256(fromBase64Url(token))); }
export function validDocumentPath(path, workspaceId, tripId, deliveryId) {
  const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
  return new RegExp(`^${workspaceId}/${tripId}/${deliveryId}/${uuid}\\.pdf$`, 'i').test(String(path || ''));
}
export function publicPortalData({ trip, passengers, documents, reservations, flights, reservationPassengers }) {
  const names = new Map((passengers || []).map(p => [p.id, [p.first_name, p.last_name].filter(Boolean).join(' ')]));
  const safeDocs = (documents || []).filter(d => !d.passenger_id).map(d => ({
    id: d.id, file_name: d.file_name, title: d.description || d.file_name, category: d.category,
    size_bytes: d.size_bytes, created_at: d.created_at
  }));
  const safeReservations = (reservations || []).map(r => ({
    id:r.id, airline_name:r.airline_name, pnr:r.pnr, checkin_opens_at:r.checkin_opens_at,
    official_checkin_url: /^https:\/\//i.test(r.official_checkin_url || '') ? r.official_checkin_url : null,
    passengers:(reservationPassengers || []).filter(x => x.reservation_id === r.id).map(x => names.get(x.passenger_id)).filter(Boolean),
    flights:(flights || []).filter(f => f.reservation_id === r.id).map(f => ({
      flight_number:f.flight_number, origin:f.origin, destination:f.destination,
      departure_at:f.departure_at, arrival_at:f.arrival_at
    }))
  }));
  return {
    trip:{ destination:trip.destination, trip_name:trip.trip_name, departure_on:trip.departure_on, return_on:trip.return_on },
    passengers:(passengers || []).map(p => ({ id:p.id, name:names.get(p.id) })),
    documents:safeDocs, reservations:safeReservations
  };
}


export function normalizeSignedStorageUrl(projectUrl, signedPath) {
  const base = new URL(projectUrl);
  const value = String(signedPath || '');
  let normalized;
  if (value.startsWith('/object/sign/')) {
    normalized = new URL('/storage/v1' + value, base.origin);
  } else {
    normalized = new URL(value, base.origin);
  }
  if (normalized.origin !== base.origin || !normalized.pathname.startsWith('/storage/v1/object/sign/') || !normalized.searchParams.has('token')) {
    throw new Error('invalid signed storage url');
  }
  return normalized.href;
}
