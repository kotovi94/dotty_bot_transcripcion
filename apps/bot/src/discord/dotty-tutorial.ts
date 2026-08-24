import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  MessageFlags,
  type ButtonInteraction,
  type InteractionReplyOptions,
} from "discord.js";

interface TutorialMessage {
  readonly content: string;
  readonly embeds: readonly EmbedBuilder[];
  readonly components: readonly ActionRowBuilder<ButtonBuilder>[];
}

const tutorialPages = [
  {
    title: "Bienvenido a Dotty",
    description: "Este recorrido te acompa\u00f1a desde una instalaci\u00f3n vac\u00eda hasta un guion narrativo revisado y publicado. Consultarlo no inicia ni modifica grabaciones.",
    fields: [
      { name: "Recorrido recomendado", value: "1. Campa\u00f1a \u2192 2. Personajes \u2192 3. Diagn\u00f3stico \u2192 4. Grabaci\u00f3n \u2192 5. Revisi\u00f3n" },
      { name: "Qui\u00e9n puede operar Dotty", value: "Todos pueden leer este tutorial. Configurar, grabar o eliminar requiere **Gestionar servidor**." },
      { name: "Privacidad", value: "El panel es privado. Dotty solo entra al canal y graba despu\u00e9s de una confirmaci\u00f3n expresa." },
    ],
  },
  {
    title: "1. Crea o revisa una campa\u00f1a",
    description: "En `/dotty`, pulsa **Configurar campa\u00f1a** y completa los tres pasos.",
    fields: [
      { name: "Nombre y numeraci\u00f3n", value: "Escribe el nombre de la aventura y el n\u00famero que tendr\u00e1 la pr\u00f3xima sesi\u00f3n." },
      { name: "Canal de voz", value: "Elige el canal de voz o escenario donde jugar\u00e1 el grupo." },
      { name: "Destino de la bit\u00e1cora", value: "Recomendado: un foro. Tambi\u00e9n puedes usar un canal de texto o el chat del canal de voz." },
      { name: "Editar", value: "Configurar otra vez una campa\u00f1a con el mismo nombre actualiza sus canales sin duplicarla." },
    ],
  },
  {
    title: "2. Identifica personajes y vocabulario",
    description: "Esto mejora los nombres mostrados y ayuda a Whisper con t\u00e9rminos propios, sin reinterpretar lo dicho.",
    fields: [
      { name: "Personajes", value: "Pulsa **Personajes**, elige la campa\u00f1a y luego un usuario. Indica personaje y, opcionalmente, nombre del jugador." },
      { name: "Editar o quitar", value: "Seleccionar de nuevo al usuario actualiza su ficha. El segundo selector elimina solamente la asignaci\u00f3n." },
      { name: "Vocabulario", value: "En **Herramientas \u2192 Vocabulario**, agrega lugares, NPC y t\u00e9rminos realmente usados, separados por comas." },
      { name: "Consejo", value: "No lo llenes con palabras generales: prioriza nombres que Whisper pueda confundir." },
    ],
  },
  {
    title: "3. Comprueba que todo est\u00e9 listo",
    description: "Antes de la primera partida abre **Herramientas \u2192 Diagn\u00f3stico**.",
    fields: [
      { name: "Qu\u00e9 revisa", value: "Canales configurados, permisos, almacenamiento y disponibilidad del transcriptor local." },
      { name: "Permisos habituales", value: "Dotty debe ver el canal de voz, conectarse, enviar mensajes y crear o escribir hilos en el destino." },
      { name: "Si aparece un error", value: "Corrige el elemento marcado y repite el diagn\u00f3stico. No comiences hasta ver **Dotty est\u00e1 preparado para grabar**." },
      { name: "Respaldo", value: "En **Herramientas** puedes crear y verificar una copia local antes de cambios importantes." },
    ],
  },
  {
    title: "4. Inicia la grabaci\u00f3n",
    description: "Cuando todos est\u00e9n en el canal, pulsa **Iniciar grabaci\u00f3n** y selecciona la campa\u00f1a.",
    fields: [
      { name: "Consentimiento", value: "Informa que las voces ser\u00e1n grabadas, transcritas y guardadas localmente. Despu\u00e9s confirma con el bot\u00f3n rojo." },
      { name: "Confirmaci\u00f3n visible", value: "Dotty indicar\u00e1 el n\u00famero de sesi\u00f3n y publicar\u00e1 un aviso en el chat asociado al canal de voz." },
      { name: "Qu\u00e9 se conserva", value: "El audio original queda separado del an\u00e1lisis. Omitir ruido de Whisper no altera el WAV guardado." },
      { name: "Si ya hay otra activa", value: "Solo puede existir una sesi\u00f3n activa por servidor. Finaliza la anterior antes de iniciar otra." },
    ],
  },
  {
    title: "5. Controla y finaliza la sesi\u00f3n",
    description: "Abre `/dotty` y pulsa **Controlar sesi\u00f3n**.",
    fields: [
      { name: "Pausar", value: "Detiene la captura y cierra correctamente el tramo actual." },
      { name: "Reanudar", value: "Contin\u00faa la misma sesi\u00f3n y conserva sus tiempos globales." },
      { name: "Finalizar", value: "Cierra la grabaci\u00f3n y env\u00eda los tramos pendientes. Espera la confirmaci\u00f3n antes de apagar Dotty." },
      { name: "Importante", value: "Pausar no es finalizar. Usa **Finalizar** al terminar para que Dotty prepare la transcripci\u00f3n." },
    ],
  },
  {
    title: "6. Genera, revisa y publica el guion",
    description: "Al terminar el procesamiento, Dotty conserva la transcripci\u00f3n en privado y no publica nada autom\u00e1ticamente.",
    fields: [
      { name: "Sesiones", value: "Consulta el estado, la fecha y el n\u00famero de cada registro." },
      { name: "Generar guion", value: "En **Sesiones**, pulsa **Generar guion**. El modelo local transforma la transcripci\u00f3n en una narraci\u00f3n coherente sin enviar datos a internet." },
      { name: "Revisar", value: "Lee y edita el guion en la aplicaci\u00f3n de Dotty. La transcripci\u00f3n original permanece intacta." },
      { name: "Publicar", value: "Pulsa **Publicar** solamente cuando el guion est\u00e9 listo. Ese bot\u00f3n crea o actualiza la entrada de Discord." },
      { name: "Corregir texto", value: "Guarda una correcci\u00f3n exacta para nombres mal reconocidos y luego genera un guion nuevo." },
      { name: "Reprocesar audio", value: "Vuelve a transcribir el WAV original tras mejorar vocabulario o configuraci\u00f3n." },
      { name: "Eliminar", value: "Borra publicaci\u00f3n, transcripci\u00f3n y audio. Dotty siempre solicita confirmaci\u00f3n." },
    ],
  },
  {
    title: "7. Mantenimiento, privacidad y ayuda",
    description: "Las opciones de cuidado est\u00e1n agrupadas en **Herramientas**.",
    fields: [
      { name: "Almacenamiento y retenci\u00f3n", value: "Consulta el espacio usado y decide cu\u00e1ndo eliminar WAV publicados. Las transcripciones se conservan." },
      { name: "Privacidad", value: "Explica qu\u00e9 se guarda, d\u00f3nde se procesa y c\u00f3mo eliminarlo." },
      { name: "Respaldos", value: "Crea, enumera y verifica copias locales. No incluyen tokens ni secretos." },
      { name: "Soluci\u00f3n r\u00e1pida", value: "Si el panel caduc\u00f3, ejecuta `/dotty` otra vez. Si algo falla, abre **Diagn\u00f3stico**." },
      { name: "Ya est\u00e1s listo", value: "Vuelve al panel y sigue: **Configurar \u2192 Personajes \u2192 Diagn\u00f3stico \u2192 Iniciar grabaci\u00f3n**." },
    ],
  },
] as const;

export const tutorialPageCount = tutorialPages.length;

export function createTutorialReply(page = 0): InteractionReplyOptions {
  return { ...createTutorialMessage(page, "dotty:tutorial:", "dotty:tutorial:cerrar", "Cerrar"), flags: MessageFlags.Ephemeral };
}

export function createPanelTutorialMessage(page = 0): TutorialMessage {
  return createTutorialMessage(page, "dotty:ui:tutorial:", "dotty:ui:home", "Volver al panel");
}

export async function handleDottyTutorialButton(interaction: ButtonInteraction): Promise<boolean> {
  if (!interaction.customId.startsWith("dotty:tutorial:")) return false;
  const target = interaction.customId.slice("dotty:tutorial:".length);
  if (target === "cerrar") {
    await interaction.update({ content: "Tutorial cerrado. Abre `/dotty` para ver el panel.", embeds: [], components: [] });
    return true;
  }
  await interaction.update(createTutorialMessage(parsePage(target), "dotty:tutorial:", "dotty:tutorial:cerrar", "Cerrar"));
  return true;
}

function createTutorialMessage(requestedPage: number, prefix: string, closeCustomId: string, closeLabel: string): TutorialMessage {
  const page = clampPage(requestedPage);
  const current = tutorialPages[page]!;
  const embed = new EmbedBuilder()
    .setColor(0x6d5dfc)
    .setTitle(`\u{1F4D6} ${current.title}`)
    .setDescription(current.description)
    .addFields(...current.fields)
    .setFooter({ text: `Paso ${page + 1} de ${tutorialPages.length} \u00b7 Puedes salir y volver cuando quieras` });
  const controls = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`${prefix}${Math.max(0, page - 1)}`).setLabel("Anterior").setStyle(ButtonStyle.Secondary).setDisabled(page === 0),
    new ButtonBuilder().setCustomId(closeCustomId).setLabel(closeLabel).setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`${prefix}${Math.min(tutorialPages.length - 1, page + 1)}`)
      .setLabel(page === tutorialPages.length - 1 ? "Completado" : "Siguiente")
      .setStyle(ButtonStyle.Primary)
      .setDisabled(page === tutorialPages.length - 1),
  );
  return { content: "", embeds: [embed], components: [controls] };
}

function parsePage(value: string): number {
  const page = Number.parseInt(value, 10);
  return Number.isInteger(page) ? page : 0;
}

function clampPage(page: number): number {
  return Math.max(0, Math.min(tutorialPages.length - 1, page));
}
