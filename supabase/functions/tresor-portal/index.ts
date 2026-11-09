import { json, preflight } from '../_shared/cors.ts';
import { tokenHash, validDocumentPath, publicPortalData, normalizeSignedStorageUrl } from '../_shared/portal-core.mjs';
const url = Deno.env.get('SUPABASE_URL') || '';
const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
const bucket = 'tresor-passenger-documents';
const hits = new Map<string,{start:number,count:number}>();
function allow(req:Request):boolean {
  const ip=req.headers.get('cf-connecting-ip')||req.headers.get('x-real-ip')||req.headers.get('x-forwarded-for')?.split(',')[0]?.trim()||'unknown';
  const now=Date.now(), entry=hits.get(ip);
  if(!entry||now-entry.start>60000){hits.set(ip,{start:now,count:1});return true;}
  entry.count++; if(hits.size>2000) for(const [k,v] of hits) if(now-v.start>120000) hits.delete(k);
  return entry.count<=45;
}
async function db(path:string, init:RequestInit={}):Promise<any>{
  const response=await fetch(`${url}/rest/v1/${path}`,{...init,headers:{apikey:key,Authorization:`Bearer ${key}`,'Content-Type':'application/json',...(init.headers||{})}});
  const body=await response.text(); if(!response.ok) throw new Error(`db-${response.status}`); return body?JSON.parse(body):null;
}
async function resolveDelivery(token:string):Promise<any|null>{
  const hash=await tokenHash(token); const query=new URLSearchParams({select:'id,workspace_id,trip_id,status,revoked_at',token_hash:`eq.${hash}`,status:'eq.active',revoked_at:'is.null',limit:'1'});
  const rows=await db(`tresor_deliveries?${query}`); return rows?.[0]||null;
}
async function view(delivery:any):Promise<any>{
  const q=new URLSearchParams({workspace_id:`eq.${delivery.workspace_id}`,id:`eq.${delivery.trip_id}`,select:'id,destination,trip_name,departure_on,return_on',limit:'1'});
  const trips=await db(`tresor_trips?${q}`); if(!trips?.length)return null;
  const groupQ=new URLSearchParams({workspace_id:`eq.${delivery.workspace_id}`,trip_id:`eq.${delivery.trip_id}`,select:'passenger_id'});
  const group=await db(`tresor_trip_passengers?${groupQ}`); const ids=[...new Set((group||[]).map((x:any)=>x.passenger_id))];
  const passengers=ids.length?await db(`tresor_passengers?${new URLSearchParams({workspace_id:`eq.${delivery.workspace_id}`,id:`in.(${ids.join(',')})`,select:'id,first_name,last_name'})}`):[];
  const docs=await db(`tresor_documents?${new URLSearchParams({workspace_id:`eq.${delivery.workspace_id}`,delivery_id:`eq.${delivery.id}`,passenger_id:'is.null',select:'id,file_name,description,category,size_bytes,created_at',order:'display_order.asc,created_at.asc'})}`);
  const reservations=await db(`tresor_air_reservations?${new URLSearchParams({workspace_id:`eq.${delivery.workspace_id}`,trip_id:`eq.${delivery.trip_id}`,select:'id,airline_name,pnr,checkin_opens_at,official_checkin_url',order:'display_order.asc,created_at.asc'})}`);
  const reservationIds=(reservations||[]).map((x:any)=>x.id);
  const flights=reservationIds.length?await db(`tresor_air_flights?${new URLSearchParams({workspace_id:`eq.${delivery.workspace_id}`,trip_id:`eq.${delivery.trip_id}`,reservation_id:`in.(${reservationIds.join(',')})`,select:'id,reservation_id,flight_number,origin,destination,departure_at,arrival_at',order:'display_order.asc'})}`):[];
  const associations=reservationIds.length?await db(`tresor_air_reservation_passengers?${new URLSearchParams({workspace_id:`eq.${delivery.workspace_id}`,trip_id:`eq.${delivery.trip_id}`,reservation_id:`in.(${reservationIds.join(',')})`,select:'reservation_id,passenger_id'})}`):[];
  return publicPortalData({trip:trips[0],passengers,documents:docs,reservations,flights,reservationPassengers:associations});
}
Deno.serve(async (req:Request)=>{
  const pre=preflight(req); if(pre)return pre;
  if(req.method!=='POST')return json(req,{error:'Método no disponible.'},405);
  if(!url||!key)return json(req,{error:'El portal no está configurado.'},503);
  if(!allow(req))return json(req,{error:'Esperá un momento e intentá nuevamente.'},429);
  try{
    const length=Number(req.headers.get('content-length')||0); if(length>16384)return json(req,{error:'Solicitud inválida.'},413);
    const body=await req.json(); const token=String(body?.token||'');
    if(!/^[A-Za-z0-9_-]{43}$/.test(token))return json(req,{error:'El enlace no está disponible.'},404);
    const delivery=await resolveDelivery(token);
    if(!delivery)return json(req,{error:'El enlace no está disponible.'},404);
    if(body.action==='view'){
      const data=await view(delivery); if(!data)return json(req,{error:'El enlace no está disponible.'},404);
      return json(req,{data});
    }
    if(body.action==='download'){
      const id=String(body.documentId||'');
      const rows=await db(`tresor_documents?${new URLSearchParams({workspace_id:`eq.${delivery.workspace_id}`,trip_id:`eq.${delivery.trip_id}`,delivery_id:`eq.${delivery.id}`,id:`eq.${id}`,passenger_id:'is.null',select:'id,storage_path',limit:'1'})}`);
      const doc=rows?.[0]; if(!doc||!validDocumentPath(doc.storage_path,delivery.workspace_id,delivery.trip_id,delivery.id))return json(req,{error:'El documento no está disponible.'},404);
      const encoded=doc.storage_path.split('/').map(encodeURIComponent).join('/');
      const signed=await fetch(`${url}/storage/v1/object/sign/${bucket}/${encoded}`,{method:'POST',headers:{apikey:key,Authorization:`Bearer ${key}`,'Content-Type':'application/json'},body:JSON.stringify({expiresIn:120})});
      if(!signed.ok)return json(req,{error:'No se pudo preparar la descarga.'},503);
      const result=await signed.json(); return json(req,{signedUrl:normalizeSignedStorageUrl(url,result.signedURL||result.signedUrl),expiresIn:120});
    }
    return json(req,{error:'Solicitud inválida.'},400);
  }catch(_){return json(req,{error:'No se pudo procesar el enlace. Intentá nuevamente.'},503);}
});
