# Fiabilidad: cambios y validación

Este documento acompaña las correcciones posteriores a la auditoría del 15 de octubre de 2026. Describe el código fuente; un instalador anterior no incorpora estos cambios hasta reconstruirse. No se han reiniciado servicios ni modificado grabaciones reales durante su implementación.

## Cambios aplicados

- Retención: una transcripción preparada no autoriza borrar audio. Informe y limpieza comparten condiciones. El plazo aún parte de `endedAt`, no de la publicación; retención nula conserva audio.
- Captura: errores de escritor, decoder, recepción o conexión se manejan como interrupción explícita. Se detiene conservadoramente, se conserva el WAV y se registra la causa. No se intenta reconstruir audio que nunca llegó de Discord. Al finalizar una sesión interrumpida puede informarse fallo; el reinicio recupera sus archivos.
- Recuperación: también procesa manifiestos `interrupted`, conserva el fin registrado y añade la fecha de recuperación. La reparación es idempotente. Los WAV recuperados señalan que el tiempo se estimó por fecha del archivo; los nuevos conservan duración PCM y origen del reloj.
- Cola: al agotarse los intentos por reinicios, el trabajo pasa a `failed`, visible y reintentable. Se conservan los tokens que impiden sobrescribir resultados desde un trabajador antiguo.
- Apagado Windows: la protección contra grabaciones activas está también en el script. El bot recibe una solicitud de cierre y debe confirmarla; si no responde, se rechaza el cierre forzado. Antes de terminar los otros procesos se comprueba su comando y pertenencia a la instalación; los PIDs no se eliminan antes de comprobarlos. La finalización real de procesos requiere validación adicional; no se ejecutó contra servicios del usuario.
- GPU: health distingue modelo cargado, dispositivo/tipo efectivos y causa de fallback. Desactivar VAD alcanza también Whisper. El panel no presenta GPU activa si el modelo no está cargado. La narrativa se detiene si Whisper no puede liberarse, en vez de ignorar el rechazo; esto no constituye todavía un planificador global de GPU.
- Participantes y repetición: el ID de cuenta sigue siendo la atribución primaria. La deduplicación exige procedencia de clips distintos y solapamiento; conserva repeticiones cercanas dentro del mismo clip. No identifica quién habla detrás de un micrófono compartido ni cuándo alguien interpreta un personaje.
- Memoria editorial: cada regla se recupera según su alcance. Los ejemplos se derivan de las reglas actualmente aprobadas y aplicables; retirar o revertir una regla retira también su influencia. Los antiguos ejemplos sin vínculo de procedencia se conservan en DB, pero ya no se recuperan a ciegas. No se requiere migración de datos.
- Ediciones: formato inválido se rechaza antes de sustituir la transcripción. Se invalida la aprobación antes de guardar, se reemplazan archivos mediante temporales y el override lleva hash del Markdown. El generador rechaza una pareja incoherente en vez de usar una corrección vieja silenciosamente.
- Fidelidad: el verificador declara que requiere revisión humana; el panel explica que aprobar estructura no prueba acontecimientos, nombres ni cantidades.
- Publicación: exclusión por archivo entre instancias y registro durable de intención antes de enviar. Se guardan IDs confirmados durante una publicación inicial. Un resultado ambiguo bloquea el reintento automático. El adjunto es una copia en memoria del texto aprobado, no una ruta que pueda cambiar mientras se envía.
- Backup: instantáneas SQLite incluyen datos confirmados en WAL. Se usa la ruta real de la DB principal y se incluyen cola, correcciones, perfiles, vocabulario y diagnósticos, sin copiar `.env` ni el secreto del transcriptor. Se rechaza captura activa antes y después de copiar. Las bases tienen snapshots individuales; no hay una transacción global entre procesos y archivos, ni se certifica una copia tomada mientras otro proceso modifica todos esos datos.
- CI: matriz Ubuntu/Windows, suite Python liviana completa y pruebas de guardado/apagado aisladas. Su ejecución remota no está verificada hasta que se publique la rama y termine Actions.

## Publicación interrumpida

No borres `.publication.lock` o `.publication-attempt.json` y pulses Publicar inmediatamente: puede haber mensajes ya enviados.

1. Comprueba que no haya un publicador vivo. Un lock sobreviviente a una caída requiere revisión, no limpieza automática.
2. Conserva copia del manifiesto y del registro. Revisa en Discord los IDs confirmados de `steps`, la publicación anterior y cualquier efecto que no llegara a guardarse tras un timeout.
3. Con una intervención explícita, reconstruye `manifest.publication` con los IDs reales para actualizar esa entrada, o elimina de forma deliberada la publicación parcial antes de permitir otra creación. No hay reconciliación automática de efectos desconocidos.
4. Solo entonces puede retirarse el registro pendiente. Se mantiene la aprobación por hash y la acción Publicar sigue siendo manual.

## Pruebas sin sesiones reales

Resultado local del 15-10-2026: 124 pruebas del bot, 24 Python y 2 de edición
aprobadas; además, tres casos PowerShell protegen recording/paused/finalizing.
Pasan los tres chequeos TypeScript y la compilación local de main y renderer
del panel. No se generó un nuevo instalador. Los tests narrativos usan un
transporte y respuestas de modelo simulados en memoria, sin puertos ni Ollama.
Un intento completo previo encontró un WAV residual del propio test; las pruebas
de WAV/JSON ahora crean carpetas independientes y pasan también al repetirse.

Las pruebas Node del bot crean sus bases de datos temporales mediante el runner habitual. Las pruebas del panel no necesitan Electron:

```powershell
node --import tsx --test apps/control-panel/scripts/transcript-edits.test.ts
powershell -NoProfile -File tools/tests/stop-dotty.test.ps1
```

Python, desde `services/transcriber`, con el venv existente y sin caché:

```powershell
$env:PYTHONDONTWRITEBYTECODE = '1'
./.venv/Scripts/python.exe -B -m pytest tests -q -p no:cacheprovider
```

Si el directorio temporal del entorno está restringido, usa `--basetemp` apuntando a una carpeta nueva exclusivamente de prueba. Pytest puede limpiar esa carpeta: nunca uses `data/recordings`, una carpeta de respaldos ni datos valiosos.

La simulación de cuatro horas adelanta un reloj con cuatro streams ficticios. Comprueba rotación, solapamiento y conservación de bytes; no mide recepción RTP, precisión de Whisper ni cuatro horas de ejecución bajo carga.

## Medición real pendiente

`benchmark_quality.py` permite medir tiempo total, factor de tiempo real (tiempo de procesamiento dividido por duración del audio) y error de palabras frente a una referencia humana. Incluye carga inicial del modelo y usa solo archivos de modelos ya disponibles; no descarga uno para medir. La tasa de error normaliza mayúsculas/puntuación, conserva tildes y no sustituye una revisión específica de nombres.

```powershell
# Desde services/transcriber, solo con audio de prueba consentido:
./.venv/Scripts/python.exe -B benchmark_quality.py C:/pruebas/audio.wav --reference C:/pruebas/referencia.txt --json
```

No se ejecutó este ensayo real durante los cambios. Antes de hacerlo: verificar memoria GPU libre, usar un único worker y no generar narrativa simultáneamente. `model_loaded` y detección CUDA no prueban precisión; la métrica de tiempo no mide directamente un pico de VRAM.

## Ensayo de aceptación de 3–4 horas pendiente

Usar un servidor de pruebas y participantes informados. Registrar entradas/salidas, silencios, dos voces a la vez, pausa/reanudación y corte de conexión. Una desconexión debe verse como interrupción y requerir recuperación; no prometer continuidad automática. Verificar hashes, cantidad de fragmentos y trabajos, cronología contra audio conocido, reintentos y restauración a una carpeta vacía. Acordar tolerancias de deriva y precisión antes del ensayo.

No publicar nada durante la prueba salvo una autorización expresa para su canal de pruebas. La suite verde no certifica una sesión Discord real ni ausencia de alucinaciones.

## Pendientes que no se ocultan con estas correcciones

- Medir latencia de disco, memoria/event loop y pérdida de paquetes antes de sustituir el escritor síncrono o introducir relleno temporal del audio.
- Recuperación automática tras reconexión, alineación RTP/muestras y deriva temporal real.
- Planificador común que impida nuevas transcripciones mientras Ollama posee la GPU.
- Reconciliación automática de publicaciones ambiguas y cierre ordenado del transcriptor durante trabajos activos.
- Políticas completas por fecha de publicación, restauración automatizada para el usuario y validación del instalador Windows.
- Evaluación factual del guion y corpus de audio revisado por humanos. YAML no se incorporó.

Reversión: revisar y revertir por componente, preservando los cambios locales anteriores. No se hizo commit, push ni reset. Los nuevos campos de JSON son aditivos; no se migró la base real. No eliminar audios o registros de publicación al revertir.
