import { json, preflight } from '../_shared/cors.ts';
import { bytesToHex, deriveToken, fromBase64Url, fromBytea, sha256, validDocumentPath } from '../_shared/portal-core.mjs';

const url = Deno.env.get('SUPABASE_URL') || '';
const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
const bucket = 'tresor-passenger-documents';

class HttpError extends Error {
  status: number;
  publicMessage: string;
  stage: string;
  constructor(status: number, publicMessage: string, stage = 'request') { super(publicMessage); this.status = status; this.publicMessage = publicMessage; this.stage = stage; }
}
class RestError extends Error {
  status: number;
  code: string;
  stage: string;
  constructor(status: number, code: string, stage: string) { super('upstream-request-failed'); this.status = status; this.code = code; this.stage = stage; }
}
function fail() { return new HttpError(400, 'La solicitud no es válida.', 'validation'); }
function uuid(value: unknown): value is string { return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value); }
function safeStoragePath(path: string) { return path.split('/').map(encodeURIComponent).join('/'); }
function safeRows(rows: any[], workspaceId: string, tripId: string, passengerId?: string): any[] {
  if (!Array.isArray(rows)) throw new HttpError(503, 'No se pudo verificar la lista de documentos. La eliminación quedó pendiente; reintentá.');
  const seen = new Set<string>();
  return rows.map((row) => {
    if (row.workspace_id !== workspaceId || !uuid(row.trip_id) || (tripId && row.trip_id !== tripId) || !uuid(row.delivery_id) ||
      (passengerId && row.passenger_id !== passengerId) || !validDocumentPath(row.storage_path, workspaceId, row.trip_id, row.delivery_id) || seen.has(row.storage_path)) {
      throw new HttpError(503, 'Una ruta de documento no coincide con el workspace y el viaje. No se completó el borrado; contactá al administrador.');
    }
    seen.add(row.storage_path);
    return row;
  });
}
async function rest(path: string, init: RequestInit = {}, stage = 'database'): Promise<any> {
  const response = await fetch(`${url}/rest/v1/${path}`, { ...init, headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', ...(init.headers || {}) } });
  const body = await response.text();
  let parsed: any = null;
  try { parsed = body ? JSON.parse(body) : null; } catch (_) { parsed = null; }
  if (!response.ok) throw new RestError(response.status, typeof parsed?.code === 'string' ? parsed.code : '', stage);
  return parsed;
}
function query(params: Record<string, string>) { return new URLSearchParams(params).toString(); }
async function authenticatedUser(req: Request) {
  const auth = req.headers.get('authorization') || '';
  const token = auth.match(/^Bearer\s+(.+)$/i)?.[1];
  if (!token) throw new HttpError(401, 'Iniciá sesión nuevamente para continuar.', 'authentication');
  const response = await fetch(`${url}/auth/v1/user`, { headers: { apikey: key, Authorization: `Bearer ${token}` } });
  if (response.status === 401 || response.status === 403) throw new HttpError(401, 'La sesión venció o no es válida. Iniciá sesión nuevamente.', 'authentication');
  if (!response.ok) throw new RestError(response.status, '', 'authentication');
  return await response.json();
}
async function requireAdmin(userId: string, workspaceId: string) {
  const q = query({ user_id: `eq.${userId}`, workspace_id: `eq.${workspaceId}`, is_active: 'eq.true', role: 'eq.admin', select: 'workspace_id', limit: '1' });
  const rows = await rest(`tresor_workspace_members?${q}`, {}, 'workspace-authorization');
  if (!rows?.length) throw new HttpError(403, 'Tu cuenta no tiene una membresía administradora activa en este workspace.', 'workspace-authorization');
}
async function getDelivery(workspaceId: string, tripId: string) {
  const q = query({ workspace_id: `eq.${workspaceId}`, trip_id: `eq.${tripId}`, select: 'id,workspace_id,trip_id,primary_passenger_id,status,revoked_at,token_hash,token_nonce,token_key_version', limit: '1' });
  return (await rest(`tresor_deliveries?${q}`))?.[0] || null;
}
function secret(version: number): string {
  const value = Deno.env.get(`TRESOR_PORTAL_HMAC_KEY_V${version}`) || '';
  if (value.length < 32) throw new HttpError(503, 'No se pudo rotar el enlace con la configuración disponible. No se borraron los datos; reintentá luego.');
  return value;
}
async function issue(id: string, nonceValue: string, version: number, storedHash?: string) {
  const out = await deriveToken(secret(version), version, id, fromBytea(nonceValue));
  if (storedHash && bytesToHex(await sha256(fromBase64Url(out.token))) !== bytesToHex(fromBytea(storedHash))) throw fail();
  return out.token;
}
async function returnDelivery(delivery: any) {
  const token = await issue(delivery.id, delivery.token_nonce, Number(delivery.token_key_version), delivery.token_hash);
  return { delivery: { id: delivery.id, trip_id: delivery.trip_id, status: delivery.status, primary_passenger_id: delivery.primary_passenger_id }, token };
}
async function removeObject(workspaceId: string, tripId: string, deliveryId: string, storagePath: string) {
  if (!validDocumentPath(storagePath, workspaceId, tripId, deliveryId)) {
    throw new HttpError(503, 'No se pudo validar una ruta de PDF; el borrado quedó pendiente y el enlace fue revocado. Reintentá o contactá al administrador.');
  }
  const headers = { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };
  try {
    await fetch(`${url}/storage/v1/object/${bucket}`, { method: 'DELETE', headers, body: JSON.stringify({ prefixes: [storagePath] }) });
  } catch (_) {
    // Aunque falle la respuesta de borrado, se consulta el objeto: un timeout puede ocurrir luego de borrarlo.
  }
  try {
    // No confiamos únicamente en el HTTP 2xx: confirmamos que el objeto físico ya no existe.
    const info = await fetch(`${url}/storage/v1/object/info/${bucket}/${safeStoragePath(storagePath)}`, { headers });
    if (info.status === 404) return;
  } catch (_) {
    // Los metadatos de la base siguen disponibles para un reintento seguro.
  }
  throw new HttpError(503, 'No se pudieron retirar todos los PDF de Storage. El registro quedó pendiente y el enlace está revocado; pulsá Eliminar nuevamente para reintentar.', 'storage-delete');
}
async function removeDocuments(rows: any[], workspaceId: string) {
  for (const row of rows) await removeObject(workspaceId, row.trip_id, row.delivery_id, row.storage_path);
}
async function ensureTripNotDeleting(workspaceId: string, tripId: string) {
  const q = query({ workspace_id: `eq.${workspaceId}`, id: `eq.${tripId}`, select: 'id,deletion_pending', limit: '1' });
  const rows = await rest(`tresor_trips?${q}`);
  if (!rows?.length) throw fail();
  if (rows[0].deletion_pending) throw new HttpError(409, 'El viaje tiene una eliminación pendiente. Reintentá el borrado antes de administrar sus documentos.');
  return rows[0];
}
async function ensureNoPassengerDeletion(workspaceId: string, tripId: string) {
  const links = await rest(`tresor_trip_passengers?${query({ workspace_id: `eq.${workspaceId}`, trip_id: `eq.${tripId}`, select: 'passenger_id' })}`);
  if (!links?.length) return;
  const ids = [...new Set(links.map((x: any) => x.passenger_id).filter(uuid))];
  if (!ids.length) return;
  const people = await rest(`tresor_passengers?${query({ workspace_id: `eq.${workspaceId}`, id: `in.(${ids.join(',')})`, select: 'id,deletion_pending' })}`);
  if (people.some((p: any) => p.deletion_pending)) throw new HttpError(409, 'Un pasajero del viaje tiene una eliminación pendiente. Reintentá esa operación primero.');
}
async function tripStillExists(workspaceId: string, tripId: string) {
  const rows = await rest(`tresor_trips?${query({ workspace_id: `eq.${workspaceId}`, id: `eq.${tripId}`, select: 'id', limit: '1' })}`, {}, 'verify-trip-delete');
  return Array.isArray(rows) && rows.length > 0;
}
async function passengerStillExists(workspaceId: string, passengerId: string) {
  const rows = await rest(`tresor_passengers?${query({ workspace_id: `eq.${workspaceId}`, id: `eq.${passengerId}`, select: 'id', limit: '1' })}`, {}, 'verify-passenger-delete');
  return Array.isArray(rows) && rows.length > 0;
}
async function deleteTrip(workspaceId: string, tripId: string, actorId: string) {
  const began = await rest('rpc/tresor_begin_trip_deletion', { method: 'POST', body: JSON.stringify({ p_workspace_id: workspaceId, p_trip_id: tripId, p_actor_id: actorId }) }, 'rpc-begin-trip');
  if (began === false) {
    if (await tripStillExists(workspaceId, tripId)) throw new HttpError(409, 'Supabase no inició la eliminación: el viaje todavía existe. No se borraron sus archivos.', 'rpc-begin-trip');
    return { deleted: true, alreadyDeleted: true, filesRemoved: 0 };
  }
  if (began !== true) throw new HttpError(502, 'Supabase no confirmó el inicio de la eliminación. No se continuará con los archivos.', 'rpc-begin-trip');
  const rows = await rest(`tresor_documents?${query({ workspace_id: `eq.${workspaceId}`, trip_id: `eq.${tripId}`, select: 'workspace_id,trip_id,delivery_id,passenger_id,storage_path' })}`);
  const documents = safeRows(rows, workspaceId, tripId);
  await removeDocuments(documents, workspaceId);
  let completed: boolean;
  try { completed = await rest('rpc/tresor_finish_trip_deletion', { method: 'POST', body: JSON.stringify({ p_workspace_id: workspaceId, p_trip_id: tripId, p_actor_id: actorId }) }, 'rpc-finish-trip'); }
  catch (error) { if (error instanceof RestError) throw error; throw new HttpError(503, 'Los PDF fueron retirados, pero la eliminación de registros no terminó. El viaje sigue pendiente; pulsá Eliminar nuevamente para reintentar.', 'rpc-finish-trip'); }
  if (completed === false) {
    if (await tripStillExists(workspaceId, tripId)) throw new HttpError(503, 'Los PDF fueron retirados, pero el viaje sigue en Supabase con la eliminación pendiente. Podés reintentar de forma segura.', 'rpc-finish-trip');
    return { deleted: true, alreadyDeleted: true, filesRemoved: documents.length };
  }
  if (completed !== true) throw new HttpError(502, 'Supabase no confirmó el borrado del viaje.', 'rpc-finish-trip');
  if (await tripStillExists(workspaceId, tripId)) throw new HttpError(502, 'Supabase respondió que terminó, pero el viaje todavía existe. No se informará como eliminado.', 'verify-trip-delete');
  return { deleted: true, filesRemoved: documents.length };
}
async function deletePassenger(workspaceId: string, passengerId: string, actorId: string) {
  const people = await rest(`tresor_passengers?${query({ workspace_id: `eq.${workspaceId}`, id: `eq.${passengerId}`, select: 'id,deletion_pending', limit: '1' })}`);
  if (!people?.length) return { deleted: true, alreadyDeleted: true, filesRemoved: 0, rotatedLinks: 0 };
  const links = await rest(`tresor_trip_passengers?${query({ workspace_id: `eq.${workspaceId}`, passenger_id: `eq.${passengerId}`, select: 'trip_id' })}`);
  const tripIds = [...new Set((links || []).map((x: any) => x.trip_id).filter(uuid))];
  const deliveries = tripIds.length ? await rest(`tresor_deliveries?${query({ workspace_id: `eq.${workspaceId}`, trip_id: `in.(${tripIds.join(',')})`, select: 'id,trip_id' })}`) : [];
  const rotations = [];
  const currentVersion = Number(Deno.env.get('TRESOR_PORTAL_CURRENT_KEY_VERSION') || '1');
  if (deliveries?.length && (!Number.isInteger(currentVersion) || currentVersion < 1)) throw new HttpError(503, 'No se pudo rotar el enlace del portal; no se borraron los datos.');
  for (const delivery of deliveries || []) {
    if (!uuid(delivery.id) || !tripIds.includes(delivery.trip_id)) throw fail();
    const nonce = crypto.getRandomValues(new Uint8Array(32));
    const derived = await deriveToken(secret(currentVersion), currentVersion, delivery.id, nonce);
    rotations.push({ delivery_id: delivery.id, token_hash: derived.tokenHash, token_nonce: derived.nonce, token_key_version: currentVersion });
  }
  const began = await rest('rpc/tresor_begin_passenger_deletion', {
    method: 'POST',
    body: JSON.stringify({ p_workspace_id: workspaceId, p_passenger_id: passengerId, p_actor_id: actorId, p_rotations: rotations })
  }, 'rpc-begin-passenger');
  if (began === false) {
    if (await passengerStillExists(workspaceId, passengerId)) throw new HttpError(409, 'Supabase no inició la eliminación: el pasajero todavía existe.', 'rpc-begin-passenger');
    return { deleted: true, alreadyDeleted: true, filesRemoved: 0, rotatedLinks: 0 };
  }
  if (began !== true) throw new HttpError(502, 'Supabase no confirmó el inicio de la eliminación del pasajero.', 'rpc-begin-passenger');
  const rows = await rest(`tresor_documents?${query({ workspace_id: `eq.${workspaceId}`, passenger_id: `eq.${passengerId}`, select: 'workspace_id,trip_id,delivery_id,passenger_id,storage_path' })}`);
  const documents = safeRows(rows, workspaceId, '', passengerId);
  await removeDocuments(documents, workspaceId);
  let completed: boolean;
  try { completed = await rest('rpc/tresor_finish_passenger_deletion', { method: 'POST', body: JSON.stringify({ p_workspace_id: workspaceId, p_passenger_id: passengerId, p_actor_id: actorId }) }, 'rpc-finish-passenger'); }
  catch (error) { if (error instanceof RestError) throw error; throw new HttpError(503, 'Los PDF individuales fueron retirados, pero la eliminación de registros no terminó. El pasajero sigue pendiente; pulsá Eliminar nuevamente para reintentar.', 'rpc-finish-passenger'); }
  if (completed === false) {
    if (await passengerStillExists(workspaceId, passengerId)) throw new HttpError(503, 'Los PDF individuales fueron retirados, pero el pasajero sigue en Supabase con la eliminación pendiente. Podés reintentar de forma segura.', 'rpc-finish-passenger');
    return { deleted: true, alreadyDeleted: true, filesRemoved: documents.length, rotatedLinks: rotations.length };
  }
  if (completed !== true) throw new HttpError(502, 'Supabase no confirmó el borrado del pasajero.', 'rpc-finish-passenger');
  if (await passengerStillExists(workspaceId, passengerId)) throw new HttpError(502, 'Supabase respondió que terminó, pero el pasajero todavía existe. No se informará como eliminado.', 'verify-passenger-delete');
  return { deleted: true, filesRemoved: documents.length, rotatedLinks: rotations.length };
}

Deno.serve(async (req: Request) => {
  const pre = preflight(req); if (pre) return pre;
  if (req.method !== 'POST') return json(req, { error: 'Método no disponible.' }, 405);
  if (!url || !key) return json(req, { error: 'La función no está configurada.' }, 503);
  let action = 'unknown';
  try {
    const body = await req.json(); action = String(body?.action || '');
    const user = await authenticatedUser(req);
    const workspaceId = String(body?.workspaceId || '');
    if (!uuid(workspaceId)) throw fail();
    await requireAdmin(user.id, workspaceId);

    if (action === 'delete-trip') {
      const tripId = String(body?.tripId || ''); if (!uuid(tripId)) throw fail();
      return json(req, await deleteTrip(workspaceId, tripId, user.id));
    }
    if (action === 'delete-passenger') {
      const passengerId = String(body?.passengerId || ''); if (!uuid(passengerId)) throw fail();
      return json(req, await deletePassenger(workspaceId, passengerId, user.id));
    }
    if (action === 'ensure') {
      const tripId = String(body?.tripId || ''); if (!uuid(tripId)) throw fail();
      await ensureTripNotDeleting(workspaceId, tripId);
      const linksQ = new URLSearchParams({ workspace_id: `eq.${workspaceId}`, trip_id: `eq.${tripId}`, select: 'passenger_id,relationship', order: 'relationship.asc,created_at.asc' });
      const links = await rest(`tresor_trip_passengers?${linksQ}`); if (!links?.length) throw fail();
      await ensureNoPassengerDeletion(workspaceId, tripId);
      const chosen = String(body?.primaryPassengerId || links.find((x: any) => x.relationship === 'primary')?.passenger_id || links[0].passenger_id);
      if (!links.some((x: any) => x.passenger_id === chosen)) throw fail();
      let delivery = await getDelivery(workspaceId, tripId);
      if (delivery) {
        if (delivery.primary_passenger_id !== chosen) {
          const q = new URLSearchParams({ workspace_id: `eq.${workspaceId}`, trip_id: `eq.${tripId}` });
          const rows = await rest(`tresor_deliveries?${q}`, { method: 'PATCH', headers: { Prefer: 'return=representation' }, body: JSON.stringify({ primary_passenger_id: chosen, updated_at: new Date().toISOString() }) });
          delivery = rows?.[0] || delivery;
        }
      } else {
        const version = Number(Deno.env.get('TRESOR_PORTAL_CURRENT_KEY_VERSION') || '1');
        if (!Number.isInteger(version) || version < 1) throw fail();
        const id = crypto.randomUUID(); const nonce = crypto.getRandomValues(new Uint8Array(32));
        const derived = await deriveToken(secret(version), version, id, nonce);
        const q = new URLSearchParams({ select: 'id,workspace_id,trip_id,primary_passenger_id,status,revoked_at,token_hash,token_nonce,token_key_version' });
        try {
          const rows = await rest(`tresor_deliveries?${q}`, { method: 'POST', headers: { Prefer: 'return=representation' }, body: JSON.stringify({ id, workspace_id: workspaceId, trip_id: tripId, primary_passenger_id: chosen, token_hash: derived.tokenHash, token_nonce: derived.nonce, token_key_version: version, status: 'draft' }) });
          delivery = rows?.[0];
        } catch (_) { delivery = await getDelivery(workspaceId, tripId); }
        if (!delivery) throw fail();
      }
      return json(req, await returnDelivery(delivery));
    }
    if (action === 'set-status') {
      const deliveryId = String(body?.deliveryId || ''); const status = String(body?.status || '');
      if (!uuid(deliveryId) || !['active', 'revoked'].includes(status)) throw fail();
      const q0 = new URLSearchParams({ workspace_id: `eq.${workspaceId}`, id: `eq.${deliveryId}`, select: 'id,workspace_id,trip_id,primary_passenger_id,status,revoked_at,token_hash,token_nonce,token_key_version', limit: '1' });
      const delivery = (await rest(`tresor_deliveries?${q0}`))?.[0]; if (!delivery) throw fail();
      await ensureTripNotDeleting(workspaceId, delivery.trip_id);
      if (status === 'active') await ensureNoPassengerDeletion(workspaceId, delivery.trip_id);
      const q = new URLSearchParams({ workspace_id: `eq.${workspaceId}`, id: `eq.${deliveryId}` });
      const patch = status === 'active' ? { status, revoked_at: null, activated_at: new Date().toISOString(), updated_at: new Date().toISOString() } : { status, revoked_at: new Date().toISOString(), updated_at: new Date().toISOString() };
      const rows = await rest(`tresor_deliveries?${q}`, { method: 'PATCH', headers: { Prefer: 'return=representation' }, body: JSON.stringify(patch) });
      return json(req, await returnDelivery(rows?.[0] || delivery));
    }
    return json(req, { error: 'Solicitud inválida.' }, 400);
  } catch (error) {
    if (error instanceof HttpError) {
      console.warn('[tresor-delivery-admin] request rejected', { action, stage: error.stage, status: error.status });
      return json(req, { error: error.publicMessage }, error.status);
    }
    if (error instanceof RestError) {
      // Log only status, SQLSTATE and stage; never log tokens, request bodies, SQL text or file paths.
      console.error('[tresor-delivery-admin] backend request failed', { action, stage: error.stage, status: error.status, code: /^[0-9A-Z]{5}$/.test(error.code) ? error.code : '' });
      if (error.code === '42501') return json(req, { error: 'Supabase rechazó la autorización administrativa de esta operación.' }, 403);
      if (error.code === '55000') return json(req, { error: 'La protección de eliminación de Supabase rechazó la operación. No se confirmó el borrado; revisá los logs y reintentá solo después de verificar su estado.' }, 409);
      if (error.stage.startsWith('storage')) return json(req, { error: 'No se pudo completar el borrado de archivos en Storage. La operación quedó pendiente y puede reintentarse.' }, 503);
      return json(req, { error: 'Supabase no pudo completar un paso de base de datos. No se confirmó la eliminación; verificá su estado antes de reintentar.' }, 502);
    }
    console.error('[tresor-delivery-admin] unexpected failure', { action, name: error instanceof Error ? error.name : 'Error' });
    return json(req, { error: 'Ocurrió un error interno. No se confirmó la eliminación; verificá el estado antes de reintentar.' }, 500);
  }
});
