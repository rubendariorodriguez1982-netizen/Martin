# STRADATA · Onboarding KYC (prototipo) en Netlify

Portal del tercero y panel del analista con datos compartidos entre dispositivos.

- `index.html` — la aplicación (panel en `/`, portal en `/vinculacion/solicitud/{token}`).
- `api.mjs` — API en `/api/*` que guarda solicitudes y documentos en **Netlify Blobs**.
- Variable de entorno obligatoria: `CLAVE_ANALISTA` (clave para entrar al panel). El tercero no necesita clave: solo ve su solicitud con el token del enlace.

## Publicar
1. Conectar este repositorio al proyecto de Netlify (Project configuration → Build & deploy → Link repository).
2. Netlify detecta `netlify.toml` (publica la raíz; la función es `api.mjs`). No hay paso de compilación.
3. Agregar `CLAVE_ANALISTA` en Project configuration → Environment variables y volver a publicar.

## Dominio
Para `kyc.stradata.co`: agregar el dominio en Netlify (Domain management) y crear en el DNS de stradata.co un CNAME `kyc` → `stradata-kyc.netlify.app`.

Datos ficticios de demostración. No usar con información real de clientes sin las medidas de producción (cifrado, retención, autenticación corporativa).
