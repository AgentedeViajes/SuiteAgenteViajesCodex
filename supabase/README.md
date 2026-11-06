# Supabase para Suite del Agente

La migración `migrations/202611060001_suite_app_data.sql` prepara el esquema y las políticas RLS para Flyers y Promociones, Rentabilidad y Agenda. Usa nombres con prefijo `suite_`, es repetible y agrega el catálogo general de 31 destinos sin borrar registros.

## Requisitos antes de conectar la Suite

1. Configurar la URL del proyecto y la clave pública `anon`/`publishable` en la integración del navegador. Esa clave es pública por diseño y solo es segura junto con RLS. No usar `service_role` en la Suite ni en archivos públicos.
2. Desactivar el registro público en Supabase Auth y crear/invitar la cuenta administradora desde el panel de Supabase. La Suite usará inicio de sesión, no registro abierto.
3. Configurar en Auth las URL permitidas para la Suite publicada y el origen local usado para migrar. `Iniciar Suite.command` sirve desde `http://127.0.0.1:4173`; `localhost` y `127.0.0.1` son orígenes de navegador distintos.
4. Ejecutar primero la consulta de preflight en `preflight.sql` desde el SQL Editor y revisar sus resultados. En particular, confirmar que no haya políticas de Storage amplias que permitan acceder a objetos de otros buckets/usuarios.
5. Solo después de revisar el preflight, ejecutar `migrations/202611060001_suite_app_data.sql` en el SQL Editor del proyecto destino. La migración crea su bucket privado; si ya existe y está público, se detiene sin volverlo privado ni modificarlo.

Si el preflight muestra el bucket como público, no ejecutar la migración. Revisar cada política existente de `storage.objects`: una política permisiva que habilite `authenticated`, `anon` o `public` sin limitar `bucket_id` puede ampliar el acceso más allá de las cuatro políticas de esta Suite; detenerse y revisarla antes de seguir.

La migración corre dentro de una transacción: si una instrucción falla, no deja el esquema aplicado a medias. Revoca los privilegios de `anon`, `PUBLIC` y `authenticated` sobre las siete tablas antes de conceder operaciones solo a `authenticated`; RLS limita esas operaciones al UID autenticado. No crea políticas para `anon` ni `PUBLIC`. El catálogo de destinos puede leerse únicamente tras autenticarse.

Después de aplicar la migración, ejecutar `postflight.sql`: deben aparecer siete tablas con RLS activo, el bucket `suite-flyer-images` con `public = false`, 31 destinos compartidos y cero filas en la consulta final de permisos para `anon`/`PUBLIC`.

## Tablas y privacidad

- `suite_flyer_promotions`, `suite_flyer_whatsapp_texts`, `suite_flyer_settings`, `suite_flyer_images`: cada fila queda ligada a `owner_id`; las políticas limitan lectura y escritura al usuario autenticado dueño.
- `suite_flyer_templates`: el catálogo con `owner_id is null` es compartido; las futuras plantillas de usuario quedan privadas.
- `suite_profitability_months`: conserva el período año/mes y el arreglo de reservas usado hoy, sin recalcular ni redondear importes.
- `suite_agenda_events`: mantiene fecha, tipo, detalle y el objeto original completo para no perder campos adicionales.
- Storage `suite-flyer-images`: bucket privado; el primer segmento de cada ruta debe ser el UID del usuario. El límite inicial es 15 MB y los formatos admitidos JPG, PNG y WebP.

## Datos locales inspeccionados

- Flyers: `suite-flyers-promotions-v1`, `suite-flyers-whatsapp-v1`, `suite-flyers-settings-v1`, `suite-flyers-library-v1` en `localStorage`; los blobs de imágenes están en IndexedDB `suite-flyers-media-v1`, almacén `blobs`.
- Rentabilidad: una clave `suite-profit-<año>-<mes>` por período; las reservas contienen `code`, `passenger`, `currency` y `amount`. El mes usa el índice JavaScript de 0 a 11.
- Agenda: `suite-agenda` en `localStorage`; cada recordatorio usa `id`, `date`, `type` y `detail`.

## Migración de datos del navegador

Los datos locales no están en el repositorio. La herramienta de migración integrada requiere iniciar sesión y descargar primero un respaldo `.json.gz` que incluye los registros y blobs de IndexedDB. Tras una confirmación explícita, sube una copia con el UID autenticado, verifica el contenido de los registros y el SHA-256 de cada imagen y conserva sin cambios los datos locales. Debe ejecutarse desde el mismo perfil de navegador y el mismo origen donde se usaron las aplicaciones.

La URL y la clave pública del proyecto están en `assets/supabase-config.js`; no hay una clave `service_role` en el frontend. El acceso se valida con Auth y no hay formulario de registro. La cuenta debe existir en Auth y el registro público debe quedar desactivado. Las aplicaciones consultan y guardan en Supabase; si falla el acceso remoto, muestran el error y no informan un guardado local como éxito.
