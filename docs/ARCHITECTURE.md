# Arquitectura de Dotty

## Objetivos

La arquitectura prioriza fidelidad del registro, recuperacion ante fallos,
operacion completamente local y capacidad de sustituir Discord, el motor de
transcripcion o la base de datos sin reescribir el dominio.

## Limites del sistema

### Bot (`apps/bot`)

Responsable de comandos, permisos, configuracion de participantes, recepcion de
audio por usuario y orquestacion de sesiones. Discord es un adaptador: las
reglas de una sesion no deben importar tipos de `discord.js`.

### Transcriptor (`services/transcriber`)

Proceso Python local que carga Faster-Whisper y recibe trabajos de audio. Devuelve
segmentos con texto, idioma, tiempos y confianza cuando el motor la proporcione.
No conoce campanas, personajes, canales ni reglas de Discord.

### Persistencia

SQLite y Prisma almacenaran metadatos, participantes, sesiones y segmentos. Los
audios y exportaciones permaneceran en el sistema de archivos; la base guardara
sus rutas, hashes y estado. Los audios nunca se eliminan automaticamente.

### Contratos compartidos (`packages/shared`)

Define identificadores, estados y mensajes entre procesos. No contiene acceso a
red, base de datos ni SDKs externos.

## Flujo previsto

1. El DM crea una sesion y selecciona los canales.
2. El bot mantiene una captura continua y pistas independientes por usuario.
3. La sesion se divide en clips logicos: busca silencio desde 55 minutos y
   fuerza el cambio de escritor a los 65, sin reiniciar la captura de Discord.
4. Un corte durante voz copia un solapamiento corto al escritor siguiente; al
   cerrar un clip, sus pistas se agregan inmediatamente a la cola persistente.
5. Faster-Whisper procesa la cola con un trabajador CUDA por defecto. No existe
   fallback silencioso a CPU.
6. El ensamblador convierte tiempos locales en tiempos globales, elimina los
   duplicados del solapamiento y deja la transcripcion preparada en privado.
7. Bajo orden manual, Ollama descarga Whisper de la GPU y `qwen3:8b` genera un
   guion por bloques, seguido de una segunda revision de fidelidad y continuidad.
8. El guion se revisa en la aplicacion y solo el boton **Publicar** crea o
   actualiza la entrada de Discord.
9. Se conservan audio, transcripcion cruda, evidencias del guion y exportaciones.

## Decisiones que protegen la fidelidad

- El audio original es la fuente de verdad; la bitacora siempre puede regenerarse.
- Cada fragmento lleva un identificador idempotente para evitar duplicados al reintentar.
- La correccion de texto sera una fase separada y conservara texto crudo y corregido.
- El hablante se obtiene de la pista de Discord, no de diarizacion de voz.
- No se intenta clasificar voz de jugador frente a voz de personaje.
- Metadata, transcripciones y exportaciones importantes se reemplazan mediante
  archivos temporales para no dejar JSON parcialmente escrito.

## REST primero

La primera integracion usara HTTP local con trabajos acotados. Es facil de probar,
reiniciar y observar. WebSocket solo se incorporara si las mediciones muestran
que se necesita transcripcion parcial de baja latencia; el contrato de segmentos
no cambia.

## Riesgos principales

- Discord no ofrece una API estable de grabacion de alto nivel; la recepcion de
  voz debe aislarse y probarse frente a reconexiones y silencio.
- Una GPU lenta puede generar atraso. Se requiere una cola persistente y control
  de presion antes de sesiones reales.
- SQLite funciona bien para una instancia local, pero las escrituras deben ser
  breves y serializadas para evitar bloqueos.
- Un modelo generativo puede inventar texto. Por eso el guion conserva evidencias,
  recibe una segunda pasada de verificacion y nunca sustituye la transcripcion cruda.
- Los mensajes privados pueden estar desactivados; la configuracion necesita un
  flujo alternativo privado dentro de Discord.
