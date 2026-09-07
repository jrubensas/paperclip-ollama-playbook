#!/usr/bin/env bash
set -e

until curl -s http://127.0.0.1:11435/ > /dev/null; do sleep 1; done

echo "[Preload] Loading qwen2.5-coder:32b across dual GPUs..."
curl -s http://127.0.0.1:11435/api/generate -d '{"model": "qwen2.5-coder:32b", "options": {"num_ctx": 16384}, "keep_alive": "24h"}' > /dev/null

echo "[Preload] Loading qwen2.5-coder:7b across dual GPUs..."
curl -s http://127.0.0.1:11435/api/generate -d '{"model": "qwen2.5-coder:7b", "options": {"num_ctx": 16384}, "keep_alive": "24h"}' > /dev/null

echo "[Preload] Both 32B and 7B models successfully preloaded into dual GPUs."
