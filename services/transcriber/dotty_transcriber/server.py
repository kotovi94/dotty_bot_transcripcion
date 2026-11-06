"""Run the local API with the Windows socket selector event loop."""

from __future__ import annotations

import asyncio
import argparse
import sys

import uvicorn


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", choices=["127.0.0.1"], required=True)
    parser.add_argument("--port", type=int, required=True)
    args = parser.parse_args()
    if sys.platform == "win32":
        asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())
    uvicorn.run("dotty_transcriber.main:app", host=args.host, port=args.port)


if __name__ == "__main__":
    main()
