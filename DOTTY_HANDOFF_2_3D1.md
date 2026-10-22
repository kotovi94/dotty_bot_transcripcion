# Dotty — Traspaso técnico para agente de VS Code

## Entorno y alcance
- Proyecto local Windows: `D:\Dotty-Bot Transcriptor`.
- Rama de trabajo: `codex/reprocess-503-regression`.
- Último commit local: `96faba5` (`fix: protect administrative deletion and reprocessing eligibility`). Anterior: `379f89b`.
- `git status` limpio al cierre; rama adelantada 2 commits respecto a origin. NO hacer push, merge ni tocar main sin autorización.
- Dotty es un bot independiente de transcripción de voz de Discord. Node.js/TypeScript, SQLite/Prisma, servicio Python Faster-Whisper/CUDA. GitHub es respaldo de código, no despliegue.
- Existen WAV reales valiosos: no tocarlos, no borrar, no iniciar bot real ni ejecutar migraciones. Usar fixtures y directorios temporales para pruebas.

## Estado implementado y probado (según reportes de Codex)
- `ReprocessIntentStore`: intenciones persistentes y rechazo de estados inciertos; coordinación por sesión.
- `SessionFileCoordinator`: exclusión entre procesos por sesión mediante lock `wx`, fail-closed; locks abandonados requieren intervención manual. Riesgo conocido si proceso externo reemplaza lock concurrentemente.
- `AudioRetentionManager.cleanupExpired()`: comprueba intención dentro del bloqueo compartido antes de borrar WAV.
- `VoiceCaptureManager.cancel()`: valida sessionId y directorio esperado antes de detener/borrar; evita cancelar captura equivocada de la misma guild.
- `SessionAdministration.delete()`: adquiere bloqueo por sesión, relee sesión/intención y rechaza pendientes o estados inciertos antes de efectos.
- `ReprocessIntentStore.create()`: bajo bloqueo comprueba sesión elegible, manifiesto y presencia/tamaño mínimo de WAV; no valida integridad criptográfica.
- Validación reportada antes del commit: 200/200 tests, tipos correctos, git diff --check limpio.

## Problema pendiente
`SessionAdministration.deleteCampaign()` lista sesiones y llama `delete()` secuencialmente, cada una con bloqueo propio. Si una sesión protegida aparece tarde, otras ya pueden haberse eliminado. Además, `SessionService.start()` puede crear nuevas sesiones sin bloqueo de campaña.

## Política elegida
Política A: si cualquier sesión de la campaña está protegida, corrupta, incierta o no se puede bloquear, abortar ANTES de cualquier efecto. Esto no proporciona atomicidad entre Discord, Python, archivos y base de datos una vez comenzado el borrado. No afirmar que es transaccional.

## Arquitectura planificada para 2.3D
- Bloqueo por campaña compartido entre procesos, en namespace separado del bloqueo por sesión.
- Orden fijo: campaña -> sesiones en orden determinista por ID.
- Bajo bloqueo de campaña, enumerar miembros; adquirir todos los bloqueos de sesión; revalidar identidad/pertenencia/intenciones antes de efectos.
- Evitar reentrancia: extraer rutina interna de borrado que asuma bloqueo de sesión adquirido; la ruta individual mantiene su propia adquisición.
- Registrar progreso y fallos parciales con precisión.
- Revisar todas las rutas de creación de sesión, no solo un llamador; impedir nuevas sesiones durante borrado de campaña.

## Tarea INMEDIATA: 2.3D.1 (solo infraestructura, no borrado de campañas)
1. Verificar rama y `git status`; si hay cambios inesperados, detenerse.
2. Auditar todos los llamadores que crean sesiones o cambian su pertenencia a campañas, y rutas de eliminación individual.
3. Diseñar e implementar el mínimo bloqueo por campaña, reutilizando el mecanismo existente si corresponde, namespace separado.
4. Coordinar altas de sesión con bloqueo por campaña; tras adquirirlo revalidar existencia y aptitud de campaña.
5. Documentar orden campaña -> sesiones ordenadas; evitar reentrancia/inversión de locks.
6. No cambiar todavía comportamiento de `deleteCampaign()`, política de retención ni formato de intenciones.
7. Si hay inversión inevitable o no se pueden cubrir las rutas, DETENERSE y explicar antes de modificar.
8. Pruebas SOLO temporales: alta normal, dos altas concurrentes, espera por lock, timeout, lock abandonado, campaña inexistente, exclusión entre procesos, campañas independientes.
9. Validar pruebas específicas, `npm run check`, `npm run typecheck`, `git diff --check`.
10. Informar archivos modificados, resultados exactos, riesgos y orden de locks. NO commit, push ni merge.

## Instrucciones de trabajo
- Cambios mínimos, sin refactorización ajena al objetivo.
- No inventar APIs ni suponer que los métodos tienen la firma esperada: inspeccionar código primero.
- Si no hay acceso al repositorio local o ejecución de pruebas, explicar la limitación, no afirmar que se validó.
- Entregar resumen compacto y criterios de aceptación.
