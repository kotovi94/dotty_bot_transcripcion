# Dotty

Dotty es un bot de Discord para registrar campanas de rol, identificar a cada
participante por su usuario y producir transcripciones y bitacoras con IA local.

## Estado

Las etapas 0 y 1 estan completas. La etapa 2 ya incluye comandos de sesion,
captura local de voz separada por hablante, manifiestos con hashes y recuperacion
tras interrupciones, validada en un canal real de Discord. La transcripcion local
con Faster-Whisper, cola persistente y reintentos tambien esta operativa.

## Componentes

- `apps/bot`: orquestacion de Discord, campanas y sesiones (Node.js/TypeScript).
- `services/transcriber`: servicio local de transcripcion (Python/Faster-Whisper).
- `packages/shared`: contratos compartidos que no dependen de Discord ni de IA.
- `docs`: arquitectura, decisiones y plan incremental.

## Comprobacion inicial

Requiere Node.js 22.18 o posterior.

```powershell
npm install
npm test
```

Las pruebas validan configuracion, dominio, persistencia y escritura WAV contra
una base SQLite temporal sin necesitar Discord, Python, una GPU ni conexion a
Internet.

Para conectar una aplicacion de Discord, consulta
[docs/SETUP_DISCORD.md](docs/SETUP_DISCORD.md).

Consulta [docs/ROADMAP.md](docs/ROADMAP.md) para ver los siguientes hitos.

## Instalador guiado para Windows

Para crear el instalador distribuible ejecuta:

```powershell
npm run installer:win
```

El resultado queda en `dist-installer/Dotty-Setup-<version>.exe`. El primer
inicio abre un asistente visual que detecta GPU NVIDIA y configura CUDA como ruta
principal sin fallback silencioso a CPU, permite elegir las rutas de Python, Node/npm y datos, prepara
las dependencias y guía la creación del bot en Discord. La misma configuración
se puede abrir después desde **Configuración** en el panel.

Las credenciales se guardan solo en el archivo `.env` local de la instalación y
el token nunca vuelve a mostrarse en pantalla. Los datos elegidos por el usuario
no se eliminan al desinstalar Dotty.

Consulta [docs/INSTALLER.md](docs/INSTALLER.md) para ver el recorrido completo y
los requisitos de una instalación sin GPU.

## Encender y apagar en Windows

Despues de completar `.env` y preparar el transcriptor, abre con doble clic
`Iniciar Dotty.cmd`. El archivo comprueba ambos servicios, evita duplicados y los
deja funcionando en segundo plano. Para cerrarlos usa `Detener Dotty.cmd`.

`Panel Dotty.exe` abre directamente la aplicacion de escritorio Electron, sin
PowerShell ni ventanas de consola, y usa el icono propio de Dotty. `Panel Dotty.cmd`
se conserva como lanzador alternativo. El panel supervisa
Discord, el transcriptor y el motor narrativo aunque se abra despues que ellos, permite encender,
apagar y reiniciar Dotty, permanece disponible desde la bandeja de Windows y
muestra GPU, cola, progreso, bitacoras editables y registros en vivo. Cerrar su
ventana no apaga el bot.

El panel anterior se conserva como `Panel Dotty - Respaldo.cmd`. Para preparar o
recompilar la aplicacion de escritorio:

```powershell
npm install
npm run panel:build
npm run panel:start
```

Para reconstruir el lanzador de Windows despues de cambiar su icono:

```powershell
powershell -ExecutionPolicy Bypass -File tools/build-panel-launcher.ps1
```

## Panel privado de Discord

Ejecuta `/dotty` para configurar campanas y personajes, iniciar o controlar una
grabacion, administrar sesiones, generar y publicar guiones, revisar almacenamiento
y crear respaldos locales verificables. Dotty no conecta la captura de voz hasta
que una persona administradora confirma que todos fueron informados.

La transcripcion utiliza localmente `large-v3-turbo`, vocabulario propio de cada
campana y metricas de confianza por palabra. El JSON conserva el texto original
del modelo y la version normalizada para permitir auditorias y correcciones.

Al finalizar, Dotty prepara la transcripcion pero no publica nada automaticamente.
Desde **Sesiones** se genera con `qwen3:8b` un guion narrativo local, que puede
revisarse y editarse en la aplicacion de escritorio. Solo el boton **Publicar**
crea o actualiza la entrada de Discord. La transcripcion cruda nunca se sustituye.
