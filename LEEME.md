# Rodeo – Historia de animales

App para el celular que funciona **sin internet** (los datos quedan guardados en el teléfono) y se respalda en **Google Drive** cuando hay señal.

## Qué hace

- **Encabezado**: total de animales activos y cuántos se van relevando en la sesión abierta.
- **Sesión**: se inicia con fecha + observación (ej. `28/10/2026 RETIRO DIU`) y opcionalmente un lugar. Se busca el animal por su número de 4 dígitos (o por el de 14, sirve también un lector de caravanas Bluetooth que "escriba" el número). Muestra la historia del animal y se carga la observación de ese día. Botón **Faltan N** para ver qué activos no se relevaron.
- **Alta de animal**: número de 4 dígitos, número de hasta 14 dígitos, macho/hembra, lugar y fecha de activación. Un animal cuenta como **activo** solo si tiene los dos números y la etiqueta activo (si falta el de 14 queda como *incompleto*).
- **Baja**: vendido, muerto u otro (con aclaración obligatoria) y fecha. Se puede reactivar.
- **Lugares**: se crean al inicio (Chacra, Media chacra, …) con fecha; traslados individuales o en grupo con fecha. Todo queda en la historia del animal.
- **Reportes**: resumen actual (activos por lugar y sexo, bajas por motivo) y reporte por sesión (activos a esa fecha, analizados, sin relevar, observaciones). Exporta a CSV (se abre en Excel) la sesión, la planilla de animales y la historia completa de cada animal desde la activación hasta la baja.
- **Backup**: archivo de respaldo para compartir a Drive/WhatsApp/mail, restauración desde archivo, y subida directa a Google Drive (un archivo por día en la carpeta *Rodeo - respaldos*), automática al cerrar cada sesión si hay señal.

## Cómo ponerla en el celular

La app tiene que estar publicada en una dirección `https://` (una sola vez). Después se instala y ya no necesita internet.

1. **Publicarla gratis con GitHub Pages** (o Netlify / Cloudflare Pages):
   - Crear una cuenta en github.com, un repositorio nuevo (ej. `rodeo`) y subir todos los archivos de esta carpeta (excepto la carpeta `.claude`).
   - En el repositorio: *Settings → Pages → Branch: main → Save*. Queda en `https://TU-USUARIO.github.io/rodeo/`.
   - Alternativa sin cuenta de GitHub: arrastrar la carpeta en https://app.netlify.com/drop.
2. **Instalarla**: abrir esa dirección en Chrome del celular (Android) → menú ⋮ → **Agregar a pantalla principal / Instalar app**. En iPhone: Safari → Compartir → **Agregar a inicio**.
3. Abrirla una vez con señal. Desde ahí funciona en el campo sin internet.

> Importante: los datos viven en el teléfono. Si se borra la app o los datos de Chrome, se pierden — por eso hay que respaldar seguido. La app avisa si pasaron 7 días sin respaldo.

## Activar la subida directa a Google Drive (opcional, una sola vez)

Sin esto igual se puede respaldar a Drive con **Guardar / compartir respaldo → Drive**. Para que suba sola:

1. Entrar a https://console.cloud.google.com/ y crear un proyecto (ej. "Rodeo").
2. *APIs y servicios → Biblioteca* → buscar **Google Drive API** → Habilitar.
3. *APIs y servicios → Pantalla de consentimiento OAuth* → tipo **Externo**, completar nombre y mail. En *Usuarios de prueba* agregar las cuentas de Gmail que van a usar la app.
4. *Credenciales → Crear credenciales → ID de cliente de OAuth* → tipo **Aplicación web**. En *Orígenes de JavaScript autorizados* poner la dirección donde publicaste la app, sin la ruta (ej. `https://tu-usuario.github.io`).
5. Copiar el **ID de cliente** (termina en `.apps.googleusercontent.com`), y en la app: *Backup → Configuración* → pegarlo → Guardar.
6. Tocar **Subir respaldo a Drive ahora**; la primera vez Google pide permiso. La app solo puede ver los archivos que ella misma crea.

## Actualizar la app

Al cambiar archivos, subirlos de nuevo y cambiar `VERSION` en `sw.js` (ej. `rodeo-v2`). El celular toma la versión nueva la próxima vez que abra la app con señal. Los datos no se tocan.

## Archivos

| Archivo | Para qué |
|---|---|
| `index.html`, `styles.css`, `app.js` | La app |
| `sw.js` | Hace que funcione sin internet |
| `manifest.webmanifest`, `icon*.png`, `icon.svg` | Instalación e ícono |
