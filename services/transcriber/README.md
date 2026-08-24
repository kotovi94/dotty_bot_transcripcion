# Servicio de transcripcion

Servicio HTTP local basado en FastAPI y Faster-Whisper. Escucha exclusivamente en
`127.0.0.1`, autentica los endpoints de trabajos con un secreto compartido y
conserva su cola en `data/transcriber.db`.

## Preparacion

Requiere Python 3.9 o posterior. Desde la raiz:

```powershell
python -m venv services/transcriber/.venv
services/transcriber/.venv/Scripts/python.exe -m pip install -r services/transcriber/requirements.txt
npm run transcriber:test
```

## Ejecucion

```powershell
npm run transcriber:start
```

El bot reintenta cada cinco segundos los manifiestos completos que aun no fueron
aceptados. El servicio recupera trabajos que estaban procesandose, rechaza IDs
reutilizados con otro audio y reintenta cada trabajo hasta tres veces.

`GET /health` informa el modelo, dispositivo activo y profundidad de la cola. Los
endpoints `/v1/*` requieren `Authorization: Bearer <secreto>`. Si el valor del
`.env` conserva el marcador de ejemplo, bot y servicio generan y comparten
`data/transcriber.secret` automaticamente.

La configuracion inicial usa `small`: permite medir el equipo y validar el flujo
sin descargar primero varios gigabytes. Si CUDA 12/cuDNN 9 no estan disponibles,
el motor cambia automaticamente a CPU `int8` sin perder el trabajo.
