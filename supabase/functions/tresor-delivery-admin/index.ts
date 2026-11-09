import { json, preflight } from '../_shared/cors.ts';
import { bytesToHex, deriveToken, fromBase64Url, fromBytea, sha256 } from '../_shared/portal-core.mjs';
const url=Deno.env.get('SUPABASE_URL')||'';
const key=Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')||'';
function fail(){return new Error('request-failed');}
async function rest(path:string,init:RequestInit={}):Promise<any>{
  const response=await fetch(`${url}/rest/v1/${path}`,{...init,headers:{apikey:key,Authorization:`Bearer ${key}`,'Content-Type':'application/json',...(init.headers||{})}});
  const body=await response.text(); if(!response.ok)throw fail(); return body?JSON.parse(body):null;
}
function uuid(value:unknown):value is string{return typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);}
function secret(version:number):string{
  const value=Deno.env.get(`TRESOR_PORTAL_HMAC_KEY_V${version}`)||'';
  if(value.length<32)throw fail(); return value;
}
async function issue(id:string,nonceValue:string,version:number,storedHash?:string){
  const out=await deriveToken(secret(version),version,id,fromBytea(nonceValue));
  if(storedHash&&bytesToHex(await sha256(fromBase64Url(out.token)))!==bytesToHex(fromBytea(storedHash)))throw fail();
  return out.token;
}
async function authenticatedUser(req:Request){
  const auth=req.headers.get('authorization')||''; const token=auth.match(/^Bearer\s+(.+)$/i)?.[1]; if(!token)throw fail();
  const response=await fetch(`${url}/auth/v1/user`,{headers:{apikey:key,Authorization:`Bearer ${token}`}});
  if(!response.ok)throw fail(); return await response.json();
}
async function requireAdmin(userId:string,workspaceId:string){
  const q=new URLSearchParams({user_id:`eq.${userId}`,workspace_id:`eq.${workspaceId}`,is_active:'eq.true',role:'eq.admin',select:'workspace_id',limit:'1'});
  const rows=await rest(`tresor_workspace_members?${q}`); if(!rows?.length)throw fail();
}
async function getDelivery(workspaceId:string,tripId:string){
  const q=new URLSearchParams({workspace_id:`eq.${workspaceId}`,trip_id:`eq.${tripId}`,select:'id,workspace_id,trip_id,primary_passenger_id,status,revoked_at,token_hash,token_nonce,token_key_version',limit:'1'});
  return (await rest(`tresor_deliveries?${q}`))?.[0]||null;
}
async function returnDelivery(delivery:any){
  const token=await issue(delivery.id,delivery.token_nonce,Number(delivery.token_key_version),delivery.token_hash);
  return {delivery:{id:delivery.id,trip_id:delivery.trip_id,status:delivery.status,primary_passenger_id:delivery.primary_passenger_id},token};
}
Deno.serve(async(req:Request)=>{
  const pre=preflight(req);if(pre)return pre;
  if(req.method!=='POST')return json(req,{error:'Método no disponible.'},405);
  if(!url||!key)return json(req,{error:'La función no está configurada.'},503);
  try{
    const body=await req.json(); const action=String(body?.action||'');
    const user=await authenticatedUser(req);
    const workspaceId=String(body?.workspaceId||'');
    if(!uuid(workspaceId))throw fail();
    await requireAdmin(user.id,workspaceId);
    if(action==='ensure'){
      const tripId=String(body?.tripId||''); if(!uuid(tripId))throw fail();
      const tripQ=new URLSearchParams({workspace_id:`eq.${workspaceId}`,id:`eq.${tripId}`,select:'id',limit:'1'});
      if(!(await rest(`tresor_trips?${tripQ}`))?.length)throw fail();
      const linksQ=new URLSearchParams({workspace_id:`eq.${workspaceId}`,trip_id:`eq.${tripId}`,select:'passenger_id,relationship',order:'relationship.asc,created_at.asc'});
      const links=await rest(`tresor_trip_passengers?${linksQ}`); if(!links?.length)throw fail();
      const chosen=String(body?.primaryPassengerId||links.find((x:any)=>x.relationship==='primary')?.passenger_id||links[0].passenger_id);
      if(!links.some((x:any)=>x.passenger_id===chosen))throw fail();
      let delivery=await getDelivery(workspaceId,tripId);
      if(delivery){
        if(delivery.primary_passenger_id!==chosen){
          const q=new URLSearchParams({workspace_id:`eq.${workspaceId}`,trip_id:`eq.${tripId}`});
          const rows=await rest(`tresor_deliveries?${q}`,{method:'PATCH',headers:{Prefer:'return=representation'},body:JSON.stringify({primary_passenger_id:chosen,updated_at:new Date().toISOString()})});
          delivery=rows?.[0]||delivery;
        }
      }else{
        const version=Number(Deno.env.get('TRESOR_PORTAL_CURRENT_KEY_VERSION')||'1');
        if(!Number.isInteger(version)||version<1)throw fail();
        const id=crypto.randomUUID(); const nonce=crypto.getRandomValues(new Uint8Array(32));
        const derived=await deriveToken(secret(version),version,id,nonce);
        const q=new URLSearchParams({select:'id,workspace_id,trip_id,primary_passenger_id,status,revoked_at,token_hash,token_nonce,token_key_version'});
        try {
          const rows=await rest(`tresor_deliveries?${q}`,{method:'POST',headers:{Prefer:'return=representation'},body:JSON.stringify({id,workspace_id:workspaceId,trip_id:tripId,primary_passenger_id:chosen,token_hash:derived.tokenHash,token_nonce:derived.nonce,token_key_version:version,status:'draft'})});
          delivery=rows?.[0];
        } catch (_) {
          // Otra solicitud pudo crear la entrega en paralelo; la restricción UNIQUE conserva una sola fila.
          delivery=await getDelivery(workspaceId,tripId);
        }
        if(!delivery)throw fail();
      }
      return json(req,await returnDelivery(delivery));
    }
    if(action==='set-status'){
      const deliveryId=String(body?.deliveryId||''); const status=String(body?.status||'');
      if(!uuid(deliveryId)||!['active','revoked'].includes(status))throw fail();
      const q0=new URLSearchParams({workspace_id:`eq.${workspaceId}`,id:`eq.${deliveryId}`,select:'id,workspace_id,trip_id,primary_passenger_id,status,revoked_at,token_hash,token_nonce,token_key_version',limit:'1'});
      const delivery=(await rest(`tresor_deliveries?${q0}`))?.[0]; if(!delivery)throw fail();
      const q=new URLSearchParams({workspace_id:`eq.${workspaceId}`,id:`eq.${deliveryId}`});
      const patch=status==='active'?{status,revoked_at:null,activated_at:new Date().toISOString(),updated_at:new Date().toISOString()}:{status,revoked_at:new Date().toISOString(),updated_at:new Date().toISOString()};
      const rows=await rest(`tresor_deliveries?${q}`,{method:'PATCH',headers:{Prefer:'return=representation'},body:JSON.stringify(patch)});
      return json(req,await returnDelivery(rows?.[0]||delivery));
    }
    return json(req,{error:'Solicitud inválida.'},400);
  }catch(_){return json(req,{error:'No se pudo autorizar o completar la operación. Revisá la sesión y el acceso del workspace.'},403);}
});
