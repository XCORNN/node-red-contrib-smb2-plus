# node-red-contrib-smb2-plus

Nodos de Node-RED para leer y escribir archivos en carpetas compartidas de Windows / Samba (SMB2), pensados para
funcionar en producción sin supervisión.

*Read in English: [README.md](README.md)*

Fork reforzado de [node-red-contrib-smb2.5](https://github.com/Delevin888/node-red-contrib-smb2.5) (a su vez
derivado de `node-red-contrib-smb` de ST-One). Los tipos de nodo se llaman igual (`SMB` y `smb config`), así que
los flujos existentes siguen funcionando.

## Por qué este fork

La librería SMB subyacente tiene limitaciones que, en el paquete original, dejan mensajes colgados para siempre
o pueden tumbar Node-RED. Medido contra el mismo servidor Samba:

| Escenario | Paquete original | Este paquete |
|---|---|---|
| 25 lecturas simultáneas | 0 correctas, 1 error, **24 mensajes sin respuesta** | 25 correctas |
| El servidor corta la sesión | 1 error `EPIPE`, **1 mensaje sin respuesta** | Reconecta de forma transparente |
| Servidor caído o colgado | Espera indefinidamente | `SMB_TIMEOUT` tras el tiempo configurado |
| Servidor ocupado o lento (respuestas provisionales `STATUS_PENDING`) | Errores `STATUS_PENDING` aleatorios | Espera la respuesta definitiva |
| Respuesta malformada del servidor | Excepción no capturada (puede tumbar Node-RED) | Reinicia la conexión e informa del error |

Qué hace:

- **Cola**: las operaciones que comparten conexión se ejecutan de una en una (la librería no soporta concurrencia).
- **Timeout** en cada operación.
- **Reconexión automática** cuando el servidor cierra la conexión o caduca la sesión.
- **Reintentos seguros**: las operaciones repetibles (leer, listar, sobrescribir, info, asegurar carpeta) se
  reintentan tras un error de conexión; las no repetibles (añadir, crear, renombrar, borrar, crear/borrar carpeta)
  solo si la petición no llegó al servidor, así que un timeout nunca duplica una línea ni renombra dos veces.
  **Los errores de login nunca se reintentan** (no bloquea cuentas del Active Directory).
- **Cierre de sesiones inactivas** y reapertura cuando hace falta, en lugar de mantenerlas abiertas siempre.
- **Mínimo privilegio**: funciona con una cuenta de servicio con permiso *Modificar* de Windows; no hace falta
  *Control total* (el paquete original lo exigía para escribir, borrar y renombrar).
- **Credenciales cifradas** en el almacén de Node-RED, en lugar de texto plano en `flows.json`.
- Modos de escritura **dar error / sobrescribir / añadir al final**, renombrar sobrescribiendo, listados con detalles.
- **Codificaciones**: detección automática, Windows-1252, UTF-16 y UTF-8 con BOM para CSV que Excel abre bien.
- Subcarpeta en el campo del recurso, puerto propio, `/` o `\` en las rutas, `DOMINIO\usuario` y `usuario@dominio`.
- Códigos de error claros, interfaz y ayuda en español e inglés, flujo de ejemplo incluido.

## Instalación

**Desinstala antes `node-red-contrib-smb2.5`**: ambos paquetes registran los mismos tipos de nodo y no pueden convivir.

**Desde un archivo `.tgz`** (p. ej. descargado de las releases de GitHub): *Menú → Manage palette → Install*,
pulsa el botón de subida y selecciona el archivo. O por consola, en la carpeta de usuario de Node-RED
(`~/.node-red`, o `/data` en Docker):

```
npm uninstall node-red-contrib-smb2.5
npm install /ruta/node-red-contrib-smb2-plus-2.0.0.tgz
```

**Desde npm** (si el paquete está publicado allí): busca `node-red-contrib-smb2-plus` en *Manage palette*, o
ejecuta `npm install node-red-contrib-smb2-plus`.

La librería SMB va incluida en el paquete: la instalación no descarga nada más.

Requisitos: Node-RED 2.0 o superior (probado en 2.2, 3.1, 4.1 y 5.0).

### Migración desde node-red-contrib-smb2.5

1. Instala como arriba. Los flujos se cargan tal cual y funcionan con las credenciales antiguas.
2. Abre **una vez** el nodo **smb config**, pulsa *Update* y *Deploy*. Usuario y contraseña pasan al almacén
   cifrado y desaparecen de `flows.json`.

Cambios de comportamiento: se ha eliminado la sobrescritura oculta desde `global.SYSCONFIG.samba`, y los errores
ahora también rellenan `msg.smbError`.

## Configuración (smb config)

| Campo | Ejemplo | Notas |
|---|---|---|
| Recurso compartido | `\\servidor.ejemplo.local\Compartido` | Admite subcarpeta (`\\servidor\Compartido\Informes`); todas las rutas pasan a ser relativas a ella. También `//servidor/Compartido`. En Docker o Linux usa el nombre DNS completo o la IP: los nombres cortos de Windows a menudo no resuelven. |
| Dominio | `EJEMPLO` o `ejemplo.local` | Vacío para cuentas locales. |
| Usuario | `node-red` | También `EJEMPLO\node-red` o `node-red@ejemplo.local`. |
| Contraseña | | Se guarda cifrada. |

Permisos: la cuenta necesita *Modificar* en las carpetas donde escribe (*Lectura* basta para flujos de solo lectura).

Opciones avanzadas:

| Opción | Por defecto | Para qué |
|---|---|---|
| Puerto | 445 | También vale `\\servidor:puerto\recurso`. |
| Timeout por operación | 60 s | Tiempo máximo por intento. Admite decimales. 0 = sin límite (no recomendado). |
| Cerrar sesión inactiva tras | 30 s | Mantenlo por debajo del timeout de inactividad del servidor. 0 = no cerrar nunca. |
| Reintentos | 1 | Intentos extra tras un error de conexión, solo si es seguro (ver arriba). Espera 0,5 s, 1 s, 1,5 s… |
| Tamaño máx. lectura | 100 MB | Los archivos se leen enteros en memoria; los mayores se rechazan. 0 = sin límite. |

## Operaciones (nodo smb)

| Operación | Entrada | Salida |
|---|---|---|
| Listar carpeta | ruta | `msg.payload`: array de nombres, o de `{name, path, isDirectory, size, birthtime, mtime, atime, ctime}` con *Incluir detalles* |
| Leer archivo | ruta | `msg.payload`: texto o Buffer |
| Escribir archivo | ruta, `msg.payload` | Si existe: *dar error* / *sobrescribir* / *añadir al final* |
| Renombrar / Mover | ruta, ruta nueva | Opción de sobrescribir el destino |
| Borrar archivo, Crear / Borrar carpeta | ruta | |
| Asegurar carpeta | ruta | Crea la carpeta y las intermedias que falten |
| Existe | ruta | `msg.exists` (true/false) |
| Información | ruta | `msg.payload`: `{name, path, isDirectory, size, birthtime, mtime, atime, ctime}` |
| Según msg.operation | `msg.operation` | Un nodo para varias operaciones: `read-dir`, `read-file`, `create`, `rename`, `unlink`, `mkdir`, `ensure-dir`, `rmdir`, `exists`, `info` |

**Rutas**: relativas al recurso compartido, p. ej. `Informes\2026\datos.csv`. Si el campo *Ruta* está vacío se usa
`msg.filename` (y `msg.new_filename` para renombrar). Se aceptan `/` y `\`, y si pegas la ruta UNC completa del
recurso configurado se recorta sola. En un nodo function recuerda escribir `\\`.

**Codificaciones.** Lectura: UTF-8, *detectar* (BOM UTF-8/UTF-16; si no, UTF-8 si es válido; si no,
Windows-1252), Windows-1252, UTF-16 LE, ISO-8859-1 o Buffer binario. Escritura: UTF-8, UTF-8 con BOM,
Windows-1252, UTF-16 LE (con BOM), ISO-8859-1. `msg.encoding` sustituye la opción del nodo. Los objetos se
escriben como JSON.

**Errores.** Si falla no se envía mensaje: usa un nodo **catch**. El código está en `msg.smbError.code` en todas
las versiones de Node-RED (y en `msg.error.code` en Node-RED 4+).

| Código | Significado |
|---|---|
| `STATUS_LOGON_FAILURE` | Usuario, contraseña o dominio incorrectos |
| `STATUS_BAD_NETWORK_NAME` | El recurso compartido no existe |
| `STATUS_OBJECT_NAME_NOT_FOUND` / `STATUS_OBJECT_PATH_NOT_FOUND` | Ruta inexistente |
| `STATUS_OBJECT_NAME_COLLISION` | Ya existe (escribir en modo *dar error*, renombrar sin sobrescribir, crear carpeta) |
| `STATUS_ACCESS_DENIED` | Sin permisos |
| `STATUS_DIRECTORY_NOT_EMPTY` | Borrar una carpeta con contenido |
| `SMB_TIMEOUT` | El servidor no respondió a tiempo |
| `SMB_SOCKET_CLOSED` | Conexión perdida durante una operación no repetible |
| `ECONNREFUSED`, `ENOTFOUND`, `EAI_AGAIN` | Problemas de red o DNS |
| `SMB_FILE_TOO_LARGE`, `SMB_IS_DIRECTORY` | Límites de lectura |
| `SMB_PATH_REQUIRED` | Operación destructiva sin ruta (protección) |
| `SMB_QUEUE_FULL` | Más de 1000 operaciones en espera (¿servidor inaccesible?) |

Si una operación no repetible falla con `SMB_TIMEOUT` o `SMB_SOCKET_CLOSED`, el servidor puede haberla ejecutado o
no: compruébalo antes de repetirla.

Hay un ejemplo listo en *Menú → Import → Examples → node-red-contrib-smb2-plus*.

## Limitaciones conocidas

- Solo SMB 2.0.2, sin firma ni cifrado: no conecta con servidores que exigen cifrado SMB3 o firma obligatoria
  (habitual en controladores de dominio). Alternativa: montar el recurso en el sistema (`mount -t cifs`) y usar los
  nodos *file* estándar.
- Lectura y escritura en memoria (sin streaming). *Añadir al final* reescribe el archivo completo.
- Las operaciones de una misma conexión son secuenciales. Para paralelismo real usa varios nodos de configuración.

## Desarrollo

```
npm install
sudo bash test/setup-samba.sh   # Samba local para los tests de integración (Debian/Ubuntu)
npm test
npm pack
```

Los tests de integración se saltan solos si no hay servidor Samba. El servidor de pruebas se puede cambiar con
`SMB_TEST_HOST`, `SMB_TEST_PORT`, `SMB_TEST_SHARE`, `SMB_TEST_ROOT`, `SMB_TEST_USER` y `SMB_TEST_PASS`, y otra
versión de Node-RED con `NODE_RED_PATH=/ruta/a/node-red/lib/red.js`.

## Licencia

Apache License 2.0. Ver [LICENSE](LICENSE) y [NOTICE](NOTICE).
