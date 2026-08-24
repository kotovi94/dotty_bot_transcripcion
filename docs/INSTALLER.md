# Instalador y asistente de configuración

El instalador de Dotty está pensado para una persona sin conocimientos técnicos.
Permite elegir la carpeta del programa y crea accesos directos en el escritorio
y el menú Inicio. Al abrir Dotty por primera vez aparece el wizard.

## Recorrido del wizard

1. **Equipo:** detecta una GPU NVIDIA mediante su controlador. El modo
   **Automático** intenta CUDA y cambia a CPU `int8` si las bibliotecas CUDA no
   están disponibles. **Solo CPU** funciona sin una tarjeta gráfica compatible.
2. **Archivos:** detecta Python y npm, pero permite localizar manualmente ambos.
   Los enlaces de ayuda llevan a las páginas oficiales de Python y Node.js. La
   carpeta de audios, bitácoras, base de datos y respaldos también es elegible.
3. **Preparación:** crea un entorno aislado de Python e instala Faster-Whisper y
   las dependencias del bot. Este paso requiere Internet la primera vez.
4. **Discord:** explica dónde crear la aplicación y dónde copiar el token, el ID
   de aplicación y el ID del servidor. La comprobación confirma que las tres
   cosas pertenecen al mismo bot y que ya puede ver el servidor.
5. **Finalización:** crea la base de datos y registra `/dotty` en ese servidor.

No se pide un ID de canal global porque Dotty permite elegir el canal de voz y
el destino de publicación para cada campaña desde `/dotty`.

## Requisitos

- Windows 10 u 11 de 64 bits.
- Python 3.10 o posterior.
- Node.js 22.18 o posterior, que incluye npm.
- Internet para preparar componentes, descargar el modelo la primera vez y
  registrar el comando de Discord.
- Una GPU NVIDIA es opcional.

El asistente puede reabrirse desde **Configuración** para cambiar rutas, modelo,
modo CUDA/CPU, servidor o credenciales. Reinstalar Dotty no elimina la carpeta de
datos seleccionada.
