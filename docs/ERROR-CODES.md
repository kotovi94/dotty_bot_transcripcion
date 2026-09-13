# Códigos de diagnóstico de Dotty

Dotty usa códigos estables para identificar advertencias y fallos durante una transcripción. El catálogo canónico vive en `packages/shared/error-codes.json` y es consumido tanto por el bot Node/TypeScript como por el transcriptor Python.

## Formato

`DOTTY-<ÁREA>-<NNNN>`

Áreas actuales:

- `DSP`: despacho y cola entre el bot y el transcriptor.
- `VAD`: análisis de actividad de voz.
- `WSP`: ejecución de Whisper/GPU.
- `VAL`: validación de calidad y alucinaciones.
- `PST`: persistencia del resultado y estado de trabajos.
- `PUB`: consolidación/exportación del transcript.
- `RPT`: generación y persistencia de reportes internos.
- `SYS`: fallos todavía no clasificados con mayor precisión.

Cada código tiene un nombre técnico estable, severidad, indicador de recuperabilidad, descripción y acción sugerida.

## Catálogo inicial

| Código | Nombre | Severidad | Significado |
|---|---|---:|---|
| `DOTTY-DSP-1001` | `TRANSCRIBER_UNAVAILABLE` | error | El bot no puede comunicarse con el servicio local de transcripción. |
| `DOTTY-DSP-1002` | `JOB_ENQUEUE_REJECTED` | error | El transcriptor rechazó un trabajo al encolarlo. |
| `DOTTY-DSP-1003` | `SESSION_DISPATCH_FAILED` | error | La sesión no pudo completar el despacho de fragmentos. |
| `DOTTY-VAD-2001` | `VAD_ANALYSIS_FAILED_FALLBACK` | warning | Falló VAD y Dotty continuó con fallback conservador `SPEECH`. |
| `DOTTY-WSP-3001` | `WHISPER_RUNTIME_FAILURE` | error | Whisper falló por un error de ejecución no CUDA. |
| `DOTTY-WSP-3002` | `WHISPER_CUDA_FAILURE` | critical | Fallo CUDA/cuBLAS/cuDNN/VRAM o inicialización GPU. |
| `DOTTY-WSP-3003` | `WHISPER_UNINTELLIGIBLE` | warning | Whisper no obtuvo texto suficientemente confiable. |
| `DOTTY-VAL-4001` | `SUSPECTED_HALLUCINATION` | warning | Segmento marcado como posible alucinación y conservado para revisión. |
| `DOTTY-VAL-4002` | `LOW_CONFIDENCE_OUTPUT` | warning | Hay salida de baja confianza que conviene revisar. |
| `DOTTY-PST-5001` | `STALE_CLAIM_DISCARDED` | warning | Se descartó un resultado porque otro claim ya era el vigente. |
| `DOTTY-PST-5002` | `VOICE_METRICS_WRITE_FAILED` | error | Falló la escritura de métricas/perfil de voz. |
| `DOTTY-PST-5003` | `TRANSCRIPTION_JOB_FAILED` | error | Un trabajo terminó en estado `failed`. |
| `DOTTY-PUB-6001` | `TRANSCRIPTION_STATUS_FETCH_FAILED` | warning | El publicador no pudo consultar temporalmente el estado de trabajos. |
| `DOTTY-PUB-6002` | `TRANSCRIPTION_EXPORT_FAILED` | error | Falló la consolidación o escritura de artefactos finales. |
| `DOTTY-RPT-7001` | `FINAL_REPORT_WARNING` | warning | El reporte final terminó con elementos que requieren revisión. |
| `DOTTY-RPT-7002` | `FINAL_REPORT_FAILURE` | error | El reporte final detectó uno o más fallos no recuperados. |
| `DOTTY-RPT-7003` | `DIAGNOSTIC_WRITE_FAILED` | warning | Dotty no pudo persistir parte del diagnóstico interno. |
| `DOTTY-SYS-9001` | `UNKNOWN_TRANSCRIPTION_FAILURE` | error | Fallo aún no clasificado en una categoría específica. |

## Cómo aparecen en los reportes

Un evento puede incluir:

```json
{
  "outcome": "failure",
  "issue": {
    "code": "DOTTY-WSP-3002",
    "name": "WHISPER_CUDA_FAILURE",
    "category": "whisper",
    "severity": "critical",
    "recoverable": true,
    "description": "...",
    "suggestedAction": "..."
  }
}
```

`report.bot.json` y `report.transcriber.json` mantienen además un mapa `codes` con el número de apariciones y una lista `recentIssues`. `transcription-report.json` consolida los códigos observados en `issues`.

## Causa y efecto

Cuando un fallo tiene una causa específica, Dotty conserva ambos niveles. Ejemplo:

1. `DOTTY-WSP-3002 · WHISPER_CUDA_FAILURE` identifica la causa técnica.
2. `DOTTY-PST-5003 · TRANSCRIPTION_JOB_FAILED` identifica el efecto sobre el trabajo.

Esto permite responder tanto “¿por qué falló?” como “¿qué parte de la sesión quedó fallida?”.

## Regla para nuevos códigos

Un código existente no debe cambiar de significado ni reutilizarse. Si aparece una nueva causa repetible, se añade un código nuevo al catálogo. `DOTTY-SYS-9001` debe usarse únicamente mientras no exista una clasificación más precisa.
