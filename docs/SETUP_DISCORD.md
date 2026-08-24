# Preparar Dotty en Discord

Dotty permite registrar campanas y grabar sesiones en un canal de voz. El audio
se conserva solo en la maquina donde se ejecuta el bot.

## 1. Crear la aplicacion

En Discord Developer Portal:

1. Crea una aplicacion y agrega un usuario bot.
2. Copia el identificador de aplicacion y el token del bot.
3. Invita el bot al servidor de pruebas con los scopes `bot` y
   `applications.commands`.
4. Concede permisos para ver y enviar mensajes, adjuntar archivos, leer el
   historial, conectar a canales de voz, crear hilos públicos y enviar mensajes
   en hilos. Añade **Gestionar canales** si quieres que Dotty cree
   automáticamente un canal de bitácora. No se requieren intents privilegiados.

Usa un servidor de desarrollo separado de una campana real.

## 2. Configurar secretos

Copia `.env.example` como `.env` en la raiz y completa:

- `DISCORD_TOKEN`: token secreto del bot.
- `DISCORD_CLIENT_ID`: identificador de la aplicacion.
- `DISCORD_GUILD_ID`: identificador del servidor de pruebas.

No compartas `.env`; Git lo ignora. Si un token aparece en registros o commits,
regeneralo inmediatamente en Discord Developer Portal.

## 3. Preparar y ejecutar

Desde la raiz del proyecto:

```powershell
npm install
npm run db:migrate
npm run commands:deploy
npm run dev
```

`commands:deploy` registra `/dotty` solo en el servidor de desarrollo. Ejecutalo
de nuevo cuando cambie la definicion del comando.

## 4. Probar

- `/dotty configurar campana:Mi campana` requiere **Gestionar servidor**.
- `/dotty estado` muestra las campanas guardadas.
- `/dotty iniciar campaña:<nombre> voz:<canal> destino:<opción>` muestra las
  campañas configuradas mientras escribes y permite publicar en el chat del
  canal de voz, usar el canal actual, crear un canal de bitácora o elegir otro
  canal de texto.
- `/dotty pausar`, `/dotty reanudar` y `/dotty finalizar` controlan la sesion.

Los WAV y su `manifest.json` quedan bajo `DOTTY_DATA_DIR/recordings/<sesion>`. No
se borran automaticamente.

Al terminar la transcripcion, Dotty no publica nada automaticamente. En `/dotty`
abre **Sesiones**, elige una sesion y pulsa **Generar guion**. Revísalo y edítalo
en la aplicación de escritorio; después pulsa **Publicar**. Ese botón crea la
entrada en el foro o hilo configurado, o actualiza la publicación previa.

Reinicia el bot y repite `/dotty estado`: la campana debe seguir disponible. Ese
es el criterio de salida de la etapa 1.
