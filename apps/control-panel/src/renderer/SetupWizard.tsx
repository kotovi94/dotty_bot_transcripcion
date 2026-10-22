import { useEffect, useMemo, useState } from "react";
import {
  Bot,
  Check,
  ChevronLeft,
  ChevronRight,
  Cpu,
  Download,
  ExternalLink,
  FolderOpen,
  KeyRound,
  LoaderCircle,
  MonitorCog,
  ShieldCheck,
} from "lucide-react";

import dottyBotImage from "./assets/dotty-bot.png";
import type { SetupConfig, SetupResult, SetupSafetyStatus, SetupStatus, TranscriptionMode } from "../shared/contracts";

const steps = ["Bienvenida", "Equipo", "Archivos", "Discord", "Listo"];

export function SetupWizard({ status, onComplete, embedded = false }: {
  status: SetupStatus;
  onComplete: (status: SetupStatus) => void;
  embedded?: boolean;
}) {
  const [step, setStep] = useState(embedded ? 1 : 0);
  const [config, setConfig] = useState<SetupConfig>({
    discordToken: "",
    keepExistingToken: status.hasDiscordToken,
    discordClientId: status.discordClientId,
    discordGuildId: status.discordGuildId,
    dataDirectory: status.dataDirectory,
    pythonExecutable: status.pythonExecutable,
    npmExecutable: status.npmExecutable,
    transcriptionMode: status.transcriptionMode,
    whisperModel: status.whisperModel,
  });
  const [result, setResult] = useState<SetupResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [prepared, setPrepared] = useState(status.checks.nodeModules && status.checks.transcriberEnvironment);
  const [safety, setSafety] = useState<SetupSafetyStatus>({ status: "unknown",
    message: "Comprobando si Dotty está inactivo.", action: "Espera a que termine la comprobación." });
  useEffect(() => {
    let active = true;
    const check = async () => {
      try {
        const next = await window.dotty.getSetupSafety(config);
        if (active) setSafety(next);
      } catch {
        if (active) setSafety({ status: "unknown", message: "No se pudo comprobar el estado de Dotty.",
          action: "Revisa el panel y vuelve a intentarlo." });
      }
    };
    void check();
    const timer = window.setInterval(() => void check(), 5_000);
    return () => { active = false; window.clearInterval(timer); };
  }, [config]);
  const modeDescription = useMemo(() => {
    if (config.transcriptionMode === "cpu") return "Funciona en cualquier PC; tarda más y usa menos memoria con precisión int8.";
    if (config.transcriptionMode === "cuda") return "Usa la GPU NVIDIA y float16 para transcribir mucho más rápido.";
    return status.gpu.detected
      ? "Usará la GPU NVIDIA detectada. Si cambias el hardware, vuelve a guardar esta configuración."
      : "Usará CPU porque no se detectó una GPU NVIDIA compatible.";
  }, [config.transcriptionMode, status.gpu.detected]);

  const update = <K extends keyof SetupConfig>(key: K, value: SetupConfig[K]) => {
    setConfig((current) => ({ ...current, [key]: value }));
    setResult(null);
    setSafety({ status: "unknown", message: "Comprobando si el cambio es seguro.", action: "Espera a que termine la comprobación." });
  };

  const browse = async (kind: "python" | "npm" | "data", key: "pythonExecutable" | "npmExecutable" | "dataDirectory") => {
    const selected = await window.dotty.browseSetupPath(kind);
    if (selected) update(key, selected);
  };

  const prepare = async () => {
    setBusy(true); setResult(null);
    try {
      const next = await window.dotty.prepareSetup(config);
      setResult(next); setPrepared(next.ok);
    } catch { setResult({ ok: false, message: "La preparación falló. Comprueba el estado de Dotty y vuelve a intentarlo." }); }
    finally { setBusy(false); }
  };

  const testDiscord = async () => {
    setBusy(true); setResult(null);
    setResult(await window.dotty.validateDiscord(config));
    setBusy(false);
  };

  const finish = async () => {
    setBusy(true); setResult(null);
    try {
      const saved = await window.dotty.saveSetup(config);
      setResult(saved);
      if (saved.ok) {
        const next = await window.dotty.getSetupStatus();
        onComplete(next);
        setStep(4);
      }
    } catch { setResult({ ok: false, message: "No se pudo guardar la configuración. Revisa el estado de Dotty." }); }
    finally { setBusy(false); }
  };

  return (
    <div className={`setup-shell ${embedded ? "embedded" : ""}`}>
      <aside className="setup-rail">
        <div className="setup-brand"><img src={dottyBotImage} alt="Dotty" /><div><strong>Configurar Dotty</strong><span>Asistente de instalación</span></div></div>
        <ol>{steps.map((label, index) => <li key={label} className={index === step ? "active" : index < step ? "done" : ""}><span>{index < step ? <Check size={14} /> : index + 1}</span>{label}</li>)}</ol>
        <small>Todo se guarda únicamente en este PC. Puedes volver a este asistente cuando quieras.</small>
      </aside>

      <main className="setup-content">
        {step === 0 && <section className="setup-intro">
          <img src={dottyBotImage} alt="" />
          <span className="eyebrow">PRIMER INICIO</span>
          <h1>Vamos a dejar a Dotty listo para tu mesa.</h1>
          <p>El asistente revisará el equipo, instalará el motor local y te acompañará para crear el bot de Discord. No necesitas saber programar.</p>
          <div className="privacy-note"><ShieldCheck size={21} /><div><strong>Audio y claves bajo tu control</strong><span>Las grabaciones, transcripciones y credenciales permanecen en la carpeta que elijas.</span></div></div>
        </section>}

        {step === 1 && <section>
          <span className="eyebrow">RENDIMIENTO</span><h1>¿Cómo quieres transcribir?</h1>
          <p className="setup-lead">Detectamos el equipo y elegimos una opción segura. Puedes forzar CPU si CUDA no funciona.</p>
          <div className={`hardware-banner ${status.gpu.detected ? "good" : "neutral"}`}><Cpu size={24} /><div><strong>{status.gpu.detected ? status.gpu.name : "No se detectó una GPU NVIDIA compatible"}</strong><span>{status.gpu.detected ? `Controlador ${status.gpu.driver}. Recomendamos Automático.` : "No hay problema: Dotty puede funcionar completamente por CPU."}</span></div></div>
          <div className="choice-grid">
            {(["auto", "cuda", "cpu"] as TranscriptionMode[]).map((mode) => <button key={mode} className={config.transcriptionMode === mode ? "selected" : ""} onClick={() => update("transcriptionMode", mode)}>
              <span>{mode === "auto" ? "Recomendado" : mode === "cuda" ? "Más rápido" : "Compatible"}</span>
              <strong>{mode === "auto" ? "Automático" : mode === "cuda" ? "GPU / CUDA" : "Solo CPU"}</strong>
              <small>{mode === "auto" ? "Elige según el equipo detectado" : mode === "cuda" ? "Requiere NVIDIA reciente" : "No requiere tarjeta gráfica"}</small>
            </button>)}
          </div>
          <div className="explanation"><MonitorCog size={20} /><span>{modeDescription}</span></div>
          {config.transcriptionMode === "cuda" && !status.gpu.detected && <button className="link-button" onClick={() => void window.dotty.openSetupLink("cuda")}><ExternalLink size={15} /> Buscar controladores NVIDIA</button>}
          <label className="setup-field compact"><span>Modelo de voz</span><select value={config.whisperModel} onChange={(event) => update("whisperModel", event.target.value)}><option value="small">Small — prueba rápida, menor calidad</option><option value="medium">Medium — equilibrado</option><option value="large-v3-turbo">Large v3 Turbo — recomendado</option><option value="large-v3">Large v3 — máxima calidad, más lento</option></select></label>
        </section>}

        {step === 2 && <section>
          <span className="eyebrow">COMPONENTES LOCALES</span><h1>Archivos y carpetas</h1>
          <p className="setup-lead">Puedes usar instalaciones existentes o indicar exactamente dónde están. Dotty crea su propio entorno aislado.</p>
          <PathField label="Python 3.10 o posterior" value={config.pythonExecutable} valid={status.checks.python} onBrowse={() => void browse("python", "pythonExecutable")} onHelp={() => void window.dotty.openSetupLink("python")} />
          <PathField label="npm (incluido con Node.js 22)" value={config.npmExecutable} valid={status.checks.npm} onBrowse={() => void browse("npm", "npmExecutable")} onHelp={() => void window.dotty.openSetupLink("node")} />
          <PathField label="Carpeta para audios, bitácoras y respaldos" value={config.dataDirectory} valid={Boolean(config.dataDirectory)} onBrowse={() => void browse("data", "dataDirectory")} />
          <button className="prepare-button" disabled={busy || safety.status !== "allowed"} onClick={() => void prepare()}>{busy ? <LoaderCircle className="spin" size={19} /> : prepared ? <Check size={19} /> : <Download size={19} />}<span><strong>{prepared ? "Componentes preparados" : "Instalar los componentes necesarios"}</strong><small>{prepared ? "Reinstalar modifica dependencias y requiere Dotty detenido." : "Instala el bot y el motor de transcripción con Dotty detenido."}</small></span></button>
        </section>}

        {step === 3 && <section>
          <span className="eyebrow">CONEXIÓN CON DISCORD</span><h1>Crea y conecta tu bot</h1>
          <p className="setup-lead">Abre el portal con el botón inferior. Crea una aplicación, entra a <b>Bot</b>, pulsa <b>Reset Token</b> y copia el token. En <b>General Information</b> encontrarás el Application ID.</p>
          <p className="setup-lead">Al guardar se actualizará .env y se registrará el comando de Discord. En una instalación nueva se preparará la base de datos; una base existente no se migrará automáticamente.</p>
          <button className="portal-button" onClick={() => void window.dotty.openSetupLink("discord")}><Bot size={20} /><span><strong>Abrir Discord Developer Portal</strong><small>discord.com/developers/applications</small></span><ExternalLink size={17} /></button>
          <div className="discord-fields">
            <label className="setup-field"><span>Token secreto del bot <em>Bot → Reset Token</em></span><div><KeyRound size={17} /><input type="password" value={config.discordToken} placeholder={status.hasDiscordToken ? "Token guardado — escribe solo para reemplazarlo" : "Pega aquí el token"} onChange={(event) => update("discordToken", event.target.value)} /></div></label>
            <label className="setup-field"><span>ID de aplicación <em>General Information → Application ID</em></span><input inputMode="numeric" value={config.discordClientId} placeholder="Ej.: 123456789012345678" onChange={(event) => update("discordClientId", event.target.value.replace(/\D/g, ""))} /></label>
            <label className="setup-field"><span>ID del servidor <em>Discord → clic derecho en el servidor → Copiar ID</em></span><input inputMode="numeric" value={config.discordGuildId} placeholder="Activa antes el Modo desarrollador de Discord" onChange={(event) => update("discordGuildId", event.target.value.replace(/\D/g, ""))} /></label>
          </div>
          <div className="channel-note"><strong>¿Y el ID del canal?</strong><span>No hace falta uno fijo. Al usar <b>/dotty</b> eliges el canal de voz y dónde publicar para cada campaña.</span></div>
          <button className="secondary-action" disabled={busy} onClick={() => void testDiscord()}>{busy ? <LoaderCircle className="spin" size={17} /> : <ShieldCheck size={17} />} Comprobar conexión</button>
        </section>}

        {step === 4 && <section className="setup-finished">
          <div className="success-orb"><Check size={40} /></div><span className="eyebrow">CONFIGURACIÓN COMPLETA</span><h1>Dotty está listo.</h1>
          <p>Enciéndelo desde la vista general. Después escribe <b>/dotty</b> en tu servidor para crear la primera campaña y elegir sus canales.</p>
          <div className="finish-summary"><span><Cpu size={18} /> {config.transcriptionMode === "cpu" ? "CPU" : config.transcriptionMode === "cuda" ? "CUDA" : "Automático"}</span><span><FolderOpen size={18} /> Datos locales configurados</span><span><ShieldCheck size={18} /> Credenciales guardadas</span></div>
        </section>}

        {(step === 2 || step === 3) && <div className={`setup-result ${safety.status === "allowed" ? "ok" : "error"}`} role="status"><span>{safety.status === "allowed" ? "✓" : "!"}</span><div><strong>{safety.status === "allowed" ? "Operación permitida" : safety.status === "blocked" ? "Operación bloqueada" : "Seguridad no verificable"}</strong><small>{safety.message}</small><small>{safety.action}</small></div></div>}
        {busy && <div className="setup-result" role="status">Operación en curso. Espera el resultado antes de continuar.</div>}
        {result && <div className={`setup-result ${result.ok ? "ok" : "error"}`}>{result.ok ? <Check size={17} /> : <span>!</span>}<div><strong>{result.message}</strong>{result.details?.map((detail) => <small key={detail}>{detail}</small>)}</div></div>}
        <footer className="setup-footer">
          <button disabled={busy || step === 0 || step === 4 || (!embedded && step === 0)} onClick={() => setStep((value) => Math.max(0, value - 1))}><ChevronLeft size={17} /> Atrás</button>
          {step < 3 && <button className="primary" disabled={busy} onClick={() => setStep(step + 1)}>Continuar <ChevronRight size={17} /></button>}
          {step === 3 && <button className="primary" disabled={busy || safety.status !== "allowed"} onClick={() => void finish()}>{busy ? <LoaderCircle className="spin" size={17} /> : <ShieldCheck size={17} />} Guardar y finalizar</button>}
          {step === 4 && <button className="primary" onClick={() => onComplete({ ...status, configured: true })}>Ir al panel <ChevronRight size={17} /></button>}
        </footer>
      </main>
    </div>
  );
}

function PathField({ label, value, valid, onBrowse, onHelp }: { label: string; value: string; valid: boolean; onBrowse: () => void; onHelp?: () => void }) {
  return <div className="path-field"><div><span>{label}</span><strong title={value}>{value || "No encontrado"}</strong></div><span className={valid ? "path-ok" : "path-warn"}>{valid ? "Detectado" : "Revisar"}</span><button onClick={onBrowse}><FolderOpen size={16} /> Buscar</button>{onHelp && <button className="icon-only" title="Descargar desde la web oficial" onClick={onHelp}><ExternalLink size={16} /></button>}</div>;
}
