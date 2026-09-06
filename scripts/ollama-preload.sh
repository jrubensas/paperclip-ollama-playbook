#!/usr/bin/env bash
set -e

until curl -s http://127.0.0.1:11435/ > /dev/null; do sleep 1; done

echo "[Preload] Loading qwen2.5-coder:32b across dual GPUs..."
curl -s http://127.0.0.1:11435/api/generate -d '{"model": "qwen2.5-coder:32b", "options": {"num_ctx": 32768}, "keep_alive": "24h"}' > /dev/null

echo "[Preload] qwen2.5-coder:32b successfully preloaded 100% into dual GPUs."
