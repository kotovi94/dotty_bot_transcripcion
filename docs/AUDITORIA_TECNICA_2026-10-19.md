# Auditoría técnica de Dotty — Fase 1

Fecha: 2026-10-19
Rama: codex/reprocess-503-regression
Estado: Auditoría inicial completada; recuperación administrativa pendiente.

## 1. Alcance

Revisión del transcriptor Python, integración Node.js, persistencia
SQLite, idempotencia, ocupaciones de trabajadores y preparación
de operaciones administrativas.

## 2. Resultados funcionales

- Faster-Whisper large-v3-turbo operativo con CUDA y float16.
- Servidor local de pruebas accesible en 127.0.0.1:18081.
- Dos trabajos completados y ninguno fallido en la consulta de salud.
- Prueba aislada de audio de 600 segundos completada.
- Integración Node.js–Python verificada.
- Idempotencia comprobada mediante repetición de solicitudes.

La prueba de 600 segundos utilizó audio repetido; no certifica
precisión real, diarización ni rendimiento de una sesión Discord.

## 3. Pruebas automatizadas

- Coordinación y dispatcher Node.js: 21 aprobadas.
- Almacenamiento Python: 23 aprobadas.
- Preparación y API administrativa Python: 33 aprobadas.

Total histórico de ejecuciones: 77 pruebas aprobadas.

Estas cifras no garantizan 77 pruebas únicas ni representan
una ejecución completa de todas las suites del repositorio.

## 4. Protecciones verificadas

- Persistencia de marcadores ante resultados HTTP inciertos.
- Prevención de duplicación de trabajos.
- Conservación de WAV durante operaciones inciertas.
- Identidad de trabajos y generaciones persistida.
- Ocupaciones de trabajadores registradas en SQLite.
- Rechazo de liberaciones con identidad o token incorrectos.
- API heredada de eliminación deshabilitada con HTTP 410.
- Preparación administrativa idempotente.
- Operaciones administrativas persistidas como pending_drain.

## 5. Hallazgo principal: recuperación administrativa

El esquema define los estados:

- pending_drain
- ready_to_delete
- completed
- failed
- uncertain

Durante esta auditoría se identificó la creación de operaciones
pending_drain, pero no una transición implementada y verificada
hasta su finalización.

El campo workers_inactive permanece en null/None porque
los registros SQLite no demuestran por sí solos que un
trabajador anterior haya terminado.

manual_recovery está reconocido como tipo de operación,
pero no se verificó un procedimiento completo de reconciliación.

Clasificación: brecha funcional pendiente de implementación.
No se observó pérdida de datos.

## 6. Eliminación directa heredada

JobStore.delete_for_session() ejecuta una eliminación SQL directa
sin aplicar internamente las barreras administrativas actuales.

No se identificaron llamadas desde el código operativo de la API.
Las pruebas utilizan deliberadamente esta función para simular
eliminación y recreación de trabajos y comprobar las protecciones
del historial y de las ocupaciones.

No eliminar ni reutilizar esta función sin revisar las pruebas
y definir un contrato de seguridad.

## 7. Trabajo pendiente

P0: Diseñar reconciliación segura de trabajadores y ocupaciones.
P1: Implementar transiciones administrativas verificables.
P1: Añadir pruebas de interrupción, reinicio y recuperación.
P2: Documentar un procedimiento manual seguro.
P2: Ejecutar ensayo Discord real de 3–4 horas con consentimiento.
P2: Evaluar precisión, diarización y alucinaciones con audio real.

## 8. Restricciones de seguridad

- No borrar archivos WAV ante estados inciertos.
- No liberar ocupaciones sin verificar la inactividad.
- No reconstruir solicitudes desde contexto potencialmente cambiado.
- No modificar SQLite manualmente para desbloquear operaciones.
- No confundir preparación administrativa con eliminación completada.

## 9. Estado de Git

Durante la auditoría se observaron tres elementos sin seguimiento:

- DOTTY_HANDOFF_2_3D1.md
- prueba 1.mp3
- pruebas-locales/

Estos elementos deben mantenerse fuera del commit de auditoría
hasta revisar individualmente su contenido y propósito.

## 10. Próximo hito

Definir el contrato de reconciliación mediante pruebas de regresión
antes de implementar operaciones que modifiquen trabajos u ocupaciones.
