# Respaldos de Dotty

## Funcionamiento automático

Al iniciar Dotty, el bot comprueba cada 15 segundos los manifiestos y las marcas
de finalización. Los respaldos se ejecutan en segundo plano:

1. Cuando una sesión deja de grabarse, se copia su audio y su estado disponible.
   También se protegen las sesiones cerradas como interrumpidas.
2. Cuando se consolida la transcripción completa de esa sesión, se crea otra copia
   que incluye los textos. Reprocesarla vuelve a generar una copia cuando cambia
   la marca `.transcription-ready`.

Cada copia automática contiene `recordings/<sesión>`, `exports/<sesión>` si existe,
los diagnósticos de esa sesión, las bases `dotty.db` y `transcriber.db` si existe,
perfiles, vocabulario, campañas y solicitudes editoriales. Las copias son por
sesión: para recuperar otras sesiones hay que conservar sus respectivas copias
o un respaldo completo. No se duplica toda la biblioteca en cada evento.

Las copias quedan en `<DOTTY_DATA_DIR>/backups`. El registro
`automatic-state.json` recuerda qué finalizaciones están respaldadas y en qué
carpeta. Solo se confirma una después de verificar todos sus tamaños y SHA-256.
Un fallo de copia, de verificación o falta de espacio queda pendiente y se
reintenta. También se detectan finalizaciones ocurridas con el bot apagado al
volver a iniciarlo. Si hay una grabación activa, se espera hasta que termine.

Los mensajes «Respaldo automático verificado» y los errores se ven en los registros
del bot. Una carpeta `.creating-*` es incompleta y no se considera un respaldo
terminado. No se borran respaldos automáticamente; su tamaño crece con las
sesiones. El tiempo de copia depende del tamaño y del disco.

## Respaldo completo manual

Desde la carpeta del proyecto:

```powershell
npm run backup
```

Incluye todas las grabaciones, exportaciones, diagnósticos, ambas bases y perfiles.
También incluye `editorial-requests`, `merge-backups`, `recovery-backups`,
`repair-backups` y `republication-backups`, cuando existen. No copia modelos,
dependencias, `.env`, el secreto del transcriptor ni otros respaldos formales.
El comando verifica los archivos, comprueba la integridad de ambas bases SQLite
presentes y escribe `verification.json`. Registra las finalizaciones que ya estaban
cubiertas antes de comenzar, para no volver a copiarlas al arrancar el bot.

SQLite se copia mediante su API de respaldo, incluyendo datos confirmados en WAL.
Cada base tiene su propia instantánea; no hay una transacción global con los
archivos ni con la otra base. Para una copia manual de recuperación completamente
quieta, termina los trabajos y detén Dotty antes de ejecutar el comando.

## Recuperación

1. Detén Dotty y conserva los datos actuales antes de reemplazarlos.
2. Revisa `backup-manifest.json` y verifica el respaldo con «Ver respaldos» /
   «Verificar integridad» en el panel privado de Discord. El respaldo debe aparecer
   como válido. La verificación no escucha audio ni comprueba exactitud del texto.
3. Copia el contenido a una carpeta vacía para inspeccionarlo primero. Los nombres
   `recordings`, `exports`, `users`, etc. conservan su posición bajo la carpeta de datos.
4. Para volver a un estado completo usa preferentemente una copia completa. Una
   copia automática contiene solo el audio/texto de su sesión, aunque las bases
   incluyen el catálogo global de ese momento. No reemplaces toda una biblioteca
   por una sola copia de sesión: faltaría el audio de las demás.
5. Una restauración selectiva requiere coordinar sus filas en la base de datos;
   copiar únicamente la carpeta de audio no recrea una sesión eliminada del catálogo.
   No existe todavía un botón que realice esa reconciliación automáticamente.

Estas copias están en el mismo disco que los originales. Protegen frente a cambios
o borrados accidentales, pero para cubrir una avería del disco conserva otra copia
en un disco externo. Las credenciales deben guardarse por separado de forma segura.

## Copia verificada durante esta implementación

El respaldo `2026-10-15T23-47-21-478Z-b580053f` contiene 111.117 archivos y
10.534.605.098 bytes de datos activos. Todos sus tamaños y SHA-256 se verificaron;
ambas bases pasan `quick_check`. Se recuperaron ambas bases, un WAV y una exportación
en una carpeta independiente: las bases conservan 9 sesiones y 45.939 trabajos.
Esto no equivale a arrancar la aplicación restaurada ni a escuchar todo el audio.

Los archivos antiguos de fusión/recuperación se conservan en un complemento
separado identificado como `historical-archive-supplement` y «Archivo histórico».
Conserva ambas carpetas. Ese complemento no reemplaza al respaldo principal.
Su nombre es `2026-10-16T13-59-15-674Z-archives-4e7f9554`: contiene 9.357 archivos,
1.166.558.137 bytes y se comparó cada copia con el SHA-256 de su origen.

La implementación pasó 129 pruebas del bot y el chequeo TypeScript. No se inició
Discord ni se certificó una partida nueva con estos cambios.
