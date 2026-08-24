# ADR 0001: Separar bot y transcriptor en procesos

- Estado: aceptada
- Fecha: 2026-08-01

## Decision

El bot se implementa en Node.js/TypeScript y la transcripcion en un servicio Python
local independiente. La primera comunicacion sera HTTP sobre `127.0.0.1`.

## Motivos

El ecosistema de Discord es mas maduro en Node, mientras Faster-Whisper y CUDA lo
son en Python. Separar procesos evita mezclar ciclos de dependencias, permite que
el bot siga guardando audio si el modelo falla y hace posible reiniciar o actualizar
el transcriptor de manera aislada.

## Costes

Habra que versionar contratos, autenticar el puerto local y operar dos procesos.
Aceptamos este coste porque reduce el impacto de fallos y facilita las pruebas.

