# Plan incremental

Cada etapa termina con una demostracion y pruebas antes de avanzar.

## Etapa 0 - Base (completada)

- Arquitectura y decisiones registradas.
- Monorepo y configuracion segura.
- Ciclo de vida de una sesion como dominio puro y probado.

Criterio de salida: las transiciones validas e invalidas de una sesion se prueban
sin Discord ni servicios externos.

## Etapa 1 - Bot minimo y persistencia (completada)

- Aplicacion de Discord con comandos `/dotty estado` y `/dotty configurar`.
- Esquema Prisma para campanas, miembros y sesiones.
- Migraciones, repositorios y pruebas de integracion con SQLite temporal.
- Registro estructurado sin secretos.

Criterio de salida: un servidor de prueba puede registrar una campana y recuperar
su configuracion despues de reiniciar el bot.

Implementado localmente. La comprobacion final contra Discord requiere las
credenciales del servidor de desarrollo.

## Etapa 2 - Captura de voz fiable (completada)

- Comandos de iniciar, pausar, reanudar y finalizar.
- Una pista por usuario, archivos atomicos y manifiesto con hashes.
- Reconexiones, consentimiento visible y recuperacion tras cierre inesperado.

Criterio de salida: una sesion simulada conserva audio atribuible por usuario aun
si el bot se reinicia.

Validado en Discord el 1 de agosto de 2026: los comandos persisten el ciclo completo, Discord se conecta sin
ensordecer al bot, cada intervencion se guarda como WAV mono atribuible, y un
manifiesto atomico conserva tiempos, tamanos y SHA-256. Al reiniciar se reparan
cabeceras WAV incompletas, el manifiesto queda marcado como interrumpido y la
sesion deja de bloquear nuevas grabaciones. La prueba real produjo tres WAV
validos (23,8 segundos en total) y todos coincidieron con sus hashes del manifiesto.

## Etapa 3 - Transcripcion local (completada)

- Servicio Faster-Whisper, cola persistente y autenticacion local.
- Seleccion de modelo basada en una prueba de GPU y memoria.
- Reintentos idempotentes y metricas de atraso.

Criterio de salida: un conjunto de audio espanol conocido se transcribe localmente
y conserva tiempos y atribucion sin perder fragmentos.

Validado el 1 de agosto de 2026 con la sesion real 2: tres fragmentos encolados
de forma idempotente terminaron con idioma, segmentos, tiempos por palabra y el
usuario de Discord original. La RTX 4060 Ti fue detectada, pero faltan las DLL de
CUDA 12/cuDNN 9; la degradacion automatica a CPU `int8` completo los trabajos sin
perderlos. La instalacion de esas DLL queda como optimizacion de rendimiento.

## Etapa 4 - Bitacora y operacion (completada)

- Ensamblado cronologico, texto crudo y version corregida trazable.
- Exportacion Markdown/JSON y publicacion controlada en Discord.
- Copias de seguridad, diagnostico y documentacion operativa.

Criterio de salida: una campana completa puede auditarse y regenerarse desde sus
audios originales.

Completada: el ensamblado cronologico, las exportaciones Markdown/JSON, la
publicacion idempotente, las correcciones trazables, el diagnostico y los
respaldos locales verificables ya funcionan. Cada respaldo conserva base de
datos, audios, manifiestos y transcripciones con huellas SHA-256, y excluye
credenciales y secretos.

## Etapa 5 - Operacion guiada en Discord (completada)

- Panel privado `/dotty` con botones, selectores y formularios.
- Configuracion de campanas y personajes sin memorizar comandos.
- Consentimiento obligatorio antes de conectar y capturar audio.
- Administracion de sesiones, correcciones, almacenamiento y respaldos.

Criterio de salida: las operaciones habituales pueden completarse desde el panel
privado; `/dotty_admin` queda solamente como respaldo de emergencia.

## Etapa 6 - Calidad de transcripcion (completada)

- Modelo multilingue `large-v3-turbo` ejecutado localmente.
- Vocabulario prioritario por campana, personajes y terminos de rol.
- Deteccion de silencios, filtro conservador de alucinaciones y normalizacion UTF-8.
- Confianza por palabra, texto original trazable y marcas para revisar.

Criterio de salida: el mismo audio real reconoce correctamente nombres, canales
y numeros que el modelo pequeno confundia, sin perder la transcripcion original.

## Etapa 7 - Bitacora inteligente (completada)

- Resumen extractivo con marcas temporales y hablante original.
- Participantes y terminos configurados detectados en la sesion.
- Momentos clave, decisiones y tareas pendientes en secciones separadas.
- Filtro de baja confianza y reglas contra ejemplos hipoteticos.
- Exportacion `bitacora-inteligente.json` y publicacion antes de la transcripcion.

Criterio de salida: cada punto de la bitacora puede rastrearse hasta una frase
real de la transcripcion; si no existe evidencia suficiente, la seccion queda
vacia en lugar de inventar contenido.

## Etapa 8 - Progreso de procesamiento (completada)

- Progreso real calculado al producir segmentos de audio.
- Fases de cola, carga, transcripcion y finalizacion persistidas.
- Tiempo transcurrido y estimacion restante en el Panel Dotty.
- Recuperacion del progreso a cero cuando un trabajo se reanuda tras reinicio.

Criterio de salida: una persona puede distinguir entre un proceso activo y uno
bloqueado, y ver una estimacion sin consultar registros tecnicos.

## Etapa 9 - Aplicacion de escritorio (completada)

- Panel Electron con interfaz aislada del acceso al sistema mediante IPC seguro.
- Supervisor de Discord y transcriptor independiente de la ventana visual.
- Encendido, apagado, reinicio y recuperacion de estado al volver a abrir.
- Icono en la bandeja de Windows y una sola instancia de la aplicacion.
- Lectura y edicion de bitacoras con respaldo automatico.
- Estado de CUDA, cola, progreso y registros en vivo.
- Panel PowerShell conservado como herramienta de emergencia.

Criterio de salida: la ventana puede cerrarse y reabrirse sin detener Dotty, el
estado se recupera desde procesos existentes y todo el ciclo de apagado y
encendido puede completarse desde Electron sin bloquear la interfaz.

## Etapa 10 - Guion narrativo local y publicación manual (completada)

- Ollama portátil y `qwen3:8b` ejecutados localmente mediante CUDA.
- Análisis por bloques, consolidación cronológica y revisión final de fidelidad.
- Guion y evidencias separados de la transcripción cruda.
- Generación, edición y publicación disponibles en Discord y en la aplicación.
- Publicación automática eliminada; solo **Publicar** crea o actualiza Discord.

Criterio de salida: una sesión terminada permanece privada hasta la orden manual,
puede convertirse en guion sin alterar el registro original y se publica una sola
vez o se actualiza de forma idempotente.
