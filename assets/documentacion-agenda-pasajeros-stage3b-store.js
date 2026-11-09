/* Etapa 3B: acceso de viajes, documentos y vuelos mediante SuiteCloud/RLS. */
(function(root,factory){if(typeof module==='object'&&module.exports)module.exports=factory();else root.PassengerDocumentsStore=factory();})(typeof globalThis!=='undefined'?globalThis:this,function(){
 'use strict';
 const BUCKET='tresor-passenger-documents', MAX=52428800;
 const tables={deliveries:'tresor_deliveries',documents:'tresor_documents',reservations:'tresor_air_reservations',flights:'tresor_air_flights',reservationPassengers:'tresor_air_reservation_passengers'};
 function eq(v){return 'eq.'+String(v)}
 function validUuid(v){return typeof v==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)}
 function path(table,filters){return '/rest/v1/'+table+'?'+new URLSearchParams(filters)}
 function encPath(value){return String(value).split('/').map(encodeURIComponent).join('/')}
 function signedStorageUrl(baseUrl,value){const base=new URL(baseUrl),raw=String(value||'');let result=raw.startsWith('/object/sign/')?new URL('/storage/v1'+raw,base.origin):new URL(raw,base.origin);if(result.origin!==base.origin||!result.pathname.startsWith('/storage/v1/object/sign/')||!result.searchParams.has('token'))throw new Error('Supabase devolvió una URL de descarga inválida.');return result.href}
 function representation(cloud,url,method,body){return cloud.api(url,{method,headers:{'Content-Type':'application/json',Prefer:'return=representation'},body:body===undefined?undefined:JSON.stringify(body)}).then(r=>r.data)}
 function cleanName(value){return String(value||'documento').normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-zA-Z0-9._-]+/g,'-').replace(/^-+|-+$/g,'').slice(0,90)||'documento'}
 async function isPdf(file){if(!file||file.size<5||file.size>MAX||!String(file.name||'').toLowerCase().endsWith('.pdf'))return false;const head=new Uint8Array(await file.slice(0,5).arrayBuffer());return String.fromCharCode(...head)==='%PDF-'}
 function create(cloud,workspaceId){
   if(!cloud||!workspaceId)throw new Error('No hay una sesión o workspace activo.');
   async function rows(table,filters,columns='*'){return cloud.selectAll(table,filters,columns)}
   async function insert(table,value){const result=await representation(cloud,'/rest/v1/'+table,'POST',value);return Array.isArray(result)?result[0]:result}
   async function patch(table,filters,value){const result=await representation(cloud,path(table,filters),'PATCH',value);return Array.isArray(result)?result[0]:result}
   async function remove(table,filters){return cloud.api(path(table,filters),{method:'DELETE'})}
   async function upload(pathValue,file,upsert){return cloud.api('/storage/v1/object/'+BUCKET+'/'+encPath(pathValue),{method:'POST',headers:{'Content-Type':'application/pdf','x-upsert':String(!!upsert)},body:file})}
   async function removeObject(pathValue){return cloud.api('/storage/v1/object/'+BUCKET,{method:'DELETE',headers:{'Content-Type':'application/json'},body:JSON.stringify({prefixes:[pathValue]})})}
   async function deleteDocument(row){await removeObject(row.storage_path);try{await remove(tables.documents,{workspace_id:eq(workspaceId),id:eq(row.id)})}catch(error){error.message='El archivo se eliminó, pero no se pudo borrar su ficha. Actualizá la lista y contactá al administrador si persiste.';throw error}}
   async function signed(pathValue){const result=await representation(cloud,'/storage/v1/object/sign/'+BUCKET+'/'+encPath(pathValue),'POST',{expiresIn:120});const signedPath=result?.signedURL||result?.signedUrl;if(!signedPath)throw new Error('Supabase no devolvió un enlace temporal.');return signedStorageUrl(window.SUITE_SUPABASE_CONFIG.url,signedPath)}
   return Object.freeze({
     workspaceId,
     async admin(action,payload){const result=await representation(cloud,'/functions/v1/tresor-delivery-admin','POST',Object.assign({action,workspaceId},payload||{}));return result},
     async listDeliveries(){return rows(tables.deliveries,{workspace_id:eq(workspaceId)},'id,trip_id,primary_passenger_id,status,created_at,activated_at,revoked_at')},
     async listDocuments(deliveryId){return rows(tables.documents,{workspace_id:eq(workspaceId),delivery_id:eq(deliveryId)},'id,trip_id,delivery_id,passenger_id,storage_path,file_name,category,description,mime_type,size_bytes,display_order,created_at')},
     async addDocument(delivery,file,metadata){
       if(!(await isPdf(file)))throw new Error('Elegí un PDF válido de hasta 50 MiB. El archivo debe comenzar con la firma PDF.');
       if(!validUuid(workspaceId)||!validUuid(delivery?.trip_id)||!validUuid(delivery?.id))throw new Error('No se pudo validar la ruta del documento. Actualizá la entrega y reintentá.');const fileId=crypto.randomUUID(),storagePath=[workspaceId,delivery.trip_id,delivery.id,fileId+'.pdf'].join('/');
       await upload(storagePath,file,false);
       try{return await insert(tables.documents,{workspace_id:workspaceId,trip_id:delivery.trip_id,delivery_id:delivery.id,passenger_id:metadata.passenger_id||null,storage_path:storagePath,file_name:cleanName(file.name),category:metadata.category,description:String(metadata.description||'').trim(),mime_type:'application/pdf',size_bytes:file.size,display_order:Number(metadata.display_order||0)})}
       catch(error){try{await removeObject(storagePath)}catch(_){}throw error}
     },
     async updateDocument(id,metadata){return patch(tables.documents,{workspace_id:eq(workspaceId),id:eq(id)},{description:String(metadata.description||'').trim(),category:metadata.category,passenger_id:metadata.passenger_id||null})},
     async replaceDocument(row,file){
       if(!(await isPdf(file)))throw new Error('Elegí un PDF válido de hasta 50 MiB.');
       if(!validUuid(workspaceId)||!validUuid(row?.trip_id)||!validUuid(row?.delivery_id))throw new Error('No se pudo validar la ruta del documento. Actualizá la lista y reintentá.');const nextPath=[workspaceId,row.trip_id,row.delivery_id,crypto.randomUUID()+'.pdf'].join('/');await upload(nextPath,file,false);
       try{await patch(tables.documents,{workspace_id:eq(workspaceId),id:eq(row.id)},{storage_path:nextPath,file_name:cleanName(file.name),mime_type:'application/pdf',size_bytes:file.size})}
       catch(error){try{await removeObject(nextPath)}catch(_){}throw error}
       try{await removeObject(row.storage_path)}catch(_){throw new Error('El PDF nuevo quedó guardado, pero el archivo anterior no se pudo retirar. Revisá Storage para evitar un archivo huérfano.')}
     },
     deleteDocument,
     async downloadDocument(row){return signed(row.storage_path)},
     async listReservations(tripId){
       const reservations=await rows(tables.reservations,{workspace_id:eq(workspaceId),trip_id:eq(tripId)},'*');
       if(!reservations.length)return [];
       const ids=reservations.map(r=>r.id), inValue='in.('+ids.join(',')+')';
       const [flights,associations]=await Promise.all([
         rows(tables.flights,{workspace_id:eq(workspaceId),trip_id:eq(tripId),reservation_id:inValue},'*'),
         rows(tables.reservationPassengers,{workspace_id:eq(workspaceId),trip_id:eq(tripId),reservation_id:inValue},'*')
       ]);
       return reservations.map(r=>Object.assign({},r,{flights:flights.filter(f=>String(f.reservation_id)===String(r.id)),passengerIds:associations.filter(a=>String(a.reservation_id)===String(r.id)).map(a=>a.passenger_id)}));
     },
     async saveReservation(tripId,record,passengerIds,flights){
       const payload={workspace_id:workspaceId,trip_id:tripId,airline_name:String(record.airline_name||'').trim(),pnr:String(record.pnr||'').trim(),checkin_opens_at:record.checkin_opens_at||null,official_checkin_url:record.official_checkin_url||null,notes:String(record.notes||''),display_order:Number(record.display_order||0),updated_at:new Date().toISOString()};
       let saved;
       if(record.id)saved=await patch(tables.reservations,{workspace_id:eq(workspaceId),trip_id:eq(tripId),id:eq(record.id)},payload);
       else saved=await insert(tables.reservations,Object.assign({},payload,{created_at:new Date().toISOString()}));
       if(!saved?.id)throw new Error('La reserva no devolvió un identificador.');
       const old=await rows(tables.reservationPassengers,{workspace_id:eq(workspaceId),trip_id:eq(tripId),reservation_id:eq(saved.id)},'passenger_id');
       const previous=new Set(old.map(x=>String(x.passenger_id))),next=new Set((passengerIds||[]).map(String));
       const additions=[...next].filter(x=>!previous.has(x));
       for(const id of old.filter(x=>!next.has(String(x.passenger_id))))await remove(tables.reservationPassengers,{workspace_id:eq(workspaceId),trip_id:eq(tripId),reservation_id:eq(saved.id),passenger_id:eq(id.passenger_id)});
       if(additions.length)await representation(cloud,'/rest/v1/'+tables.reservationPassengers,'POST',additions.map(passenger_id=>({workspace_id:workspaceId,trip_id:tripId,reservation_id:saved.id,passenger_id})));
       const current=record.id?await rows(tables.flights,{workspace_id:eq(workspaceId),trip_id:eq(tripId),reservation_id:eq(saved.id)},'*'):[];
       const keep=new Set((flights||[]).filter(f=>f.id).map(f=>String(f.id)));
       for(const f of flights||[]){const flight={workspace_id:workspaceId,trip_id:tripId,reservation_id:saved.id,flight_number:String(f.flight_number||''),origin:String(f.origin||'').trim(),destination:String(f.destination||'').trim(),departure_at:f.departure_at,arrival_at:f.arrival_at,display_order:Number(f.display_order||0)};if(f.id)await patch(tables.flights,{workspace_id:eq(workspaceId),trip_id:eq(tripId),reservation_id:eq(saved.id),id:eq(f.id)},flight);else await insert(tables.flights,Object.assign({},flight,{created_at:new Date().toISOString()}))}
       for(const f of current)if(!keep.has(String(f.id)))await remove(tables.flights,{workspace_id:eq(workspaceId),trip_id:eq(tripId),reservation_id:eq(saved.id),id:eq(f.id)});
       return saved;
     },
     async deleteReservation(tripId,id){
       const filters={workspace_id:eq(workspaceId),trip_id:eq(tripId),reservation_id:eq(id)};
       for(const f of await rows(tables.flights,filters,'id'))await remove(tables.flights,{workspace_id:eq(workspaceId),trip_id:eq(tripId),id:eq(f.id)});
       for(const p of await rows(tables.reservationPassengers,filters,'passenger_id'))await remove(tables.reservationPassengers,{workspace_id:eq(workspaceId),trip_id:eq(tripId),reservation_id:eq(id),passenger_id:eq(p.passenger_id)});
       await remove(tables.reservations,{workspace_id:eq(workspaceId),trip_id:eq(tripId),id:eq(id)});
     }
   });
 }
 return Object.freeze({create,isPdf,MAX});
});
