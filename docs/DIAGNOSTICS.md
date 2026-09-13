# Diagnóstico interno de transcripciones

Dotty mantiene una traza técnica por sesión para poder explicar qué hizo, qué salió bien, qué quedó dudoso y dónde falló. Esta información no se publica en Discord ni se mezcla con `bitacora.md`, `transcript_full.txt` o `guion.md`.

## Activación

El diagnóstico está activo por defecto:

```env
DOTTY_DIAGNOSTICS_ENABLED=true
```

Puede desactivarse con `false`, `0`, `no` u `off`.

## Ubicación

Los archivos se guardan dentro de `DOTTY_DATA_DIR/.diagnostics/<session-id>/`. `data/` ya está excluido de Git, por lo que estos reportes permanecen locales.

Archivos principales:

- `activity.transcriber.jsonl`: historial append-only del servicio Python. Registra cola, VAD, Whisper, persistencia, métricas de voz, reintentos y fallos.
- `report.transcriber.json`: resumen acumulado del servicio Python, con contadores por proceso, tiempos y fallos recientes.
- `jobs/<job-id>.json`: historia completa de cada fragmento procesado por Whisper.
- `activity.bot.jsonl`: historial del bot Node para contexto, despacho y consolidación de la sesión.
- `report.bot.json`: resumen acumulado del lado del bot.
- `transcription-report.json`: informe final legible por máquina y por una herramienta de diagnóstico. Resume calidad, rendimiento, advertencias, fallos y artefactos generados.

Los reportes de diagnóstico no almacenan el texto completo de la transcripción. Las métricas sensibles cuyo nombre contenga `token`, `secret`, `authorization` o `password` se censuran automáticamente.

## Qué se registra

Cada evento indica como mínimo:

- sesión, componente y proceso;
- resultado: `started`, `success`, `warning`, `failure`, `skipped` o `info`;
- una explicación breve de lo ocurrido;
- evidencia de por qué Dotty considera correcto o dudoso el resultado;
- duración cuando se puede medir;
- métricas relevantes sin copiar el contenido de la conversación;
- error estructurado cuando existe.

Para Whisper se registran, entre otras métricas, dispositivo activo, duración de audio, duración tras VAD, tiempo de proceso, tiempo GPU, factor de tiempo real, segmentos aceptados, segmentos sospechosos, cantidad de palabras y confianza media de palabra.

## Informe final

Cuando aparece `.transcription-ready` o `.transcription-failed`, `TranscriptionReportService` construye `transcription-report.json`. El informe combina:

- el historial interno del bot;
- el historial del transcriptor;
- `voice_metrics.json`;
- `transcript.raw.json` y su resumen de calidad;
- la presencia real de los artefactos de salida.

El resultado global es `success`, `warning` o `failure` y contiene `whatWentWell`, `warnings`, `failures` y comprobaciones por etapa. Así se puede comparar sesiones sin leer manualmente miles de líneas de log.

## Consulta del transcriptor

El servicio Python expone dos endpoints autenticados para inspección local:

- `GET /v1/sessions/{session_id}/diagnostics`
- `GET /v1/jobs/{job_id}/diagnostics`

Estos endpoints devuelven los resúmenes internos; no exponen secretos ni el texto completo de la sesión.
