// The former manual recovery deleted Python jobs without proving that active
// workers had stopped. Keep this CLI unavailable until the drain protocol is
// integrated. No configuration option can bypass this gate.
const code = "RECOVERY_PROTOCOL_PENDING";
const message = "La recuperación manual está temporalmente deshabilitada hasta verificar la inactividad de los workers Python. No se modificaron archivos ni datos.";

process.stderr.write(`${JSON.stringify({ ok: false, code, message })}\n`);
process.exitCode = 1;
