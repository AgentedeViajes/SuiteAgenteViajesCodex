# Documentación y Agenda de Pasajeros — preparación de Preview

## Alcance

Esta rama parte de `origin/main` y agrega la tarjeta número 15, la aplicación administrativa y el portal de pasajero, junto con pruebas y fuentes de las Edge Functions. El Preview de Vercel se usará solo para inspección visual: no iniciar sesión ni ejecutar acciones sobre datos.

## Estado remoto informado por el administrador

Las migraciones se aplicaron manualmente desde Supabase SQL Editor. Los postflights confirmaron las tablas principales con RLS activo y la restricción única por workspace y viaje válida. No existe `supabase_migrations.schema_migrations`; por lo tanto, no se puede certificar desde ese historial el texto exacto de la migración 001 que se ejecutó.

La fuente local separa el esquema en 001 (cinco tablas principales), 002 (ocho tablas de entregas) y 003 (unicidad de una entrega por viaje). Esta estructura es coherente con el estado remoto informado, pero no es una transcripción verificable de la ejecución histórica.

**No volver a ejecutar las migraciones 001, 002 ni 003. No usar `supabase db push` ni `migration repair` como parte del Preview.** Los archivos SQL no se incluyen en esta rama visual.

## Seguridad del Preview

La configuración pública `assets/supabase-config.js` apunta al proyecto Supabase de producción. No iniciar sesión ni guardar, editar, subir o eliminar datos desde el Preview. Para hacer pruebas autenticadas se necesitaría primero un backend de QA y una configuración pública separada, aprobados expresamente.

Las Edge Functions no son desplegadas por Vercel. Se incluyen sus fuentes locales y `supabase/config.toml` para mantenerlas bajo control de versiones, pero la igualdad byte a byte con el bundle remoto desplegado no fue verificada. No desplegarlas desde esta rama.

El CORS de las Functions valida orígenes exactos. El origen de Preview puede no estar permitido por la configuración actual; esta rama no modifica secretos ni listas CORS.

## Verificación de publicación

El repositorio local apunta al remoto `AgentedeViajes/SuiteAgenteViajesCodex`; `origin/main` se actualizó para preparar esta rama. No hay `vercel.json`, `.vercel/project.json`, `package.json` ni CLI de Vercel local, así que Production branch y Output Directory deben confirmarse en Project Settings de Vercel antes del push. La rama de producción informada previamente es `main`.
