# 02. Configuração do Ollama em Dual-GPU e Preloader de Modelo

Neste documento apresentamos a configuração de baixo nível do serviço Ollama, detalhando todas as variáveis de ambiente necessárias para unir duas GPUs NVIDIA via CUDA, otimizações de Flash Attention e o serviço de pré-carregamento permanente na memória.

---

## 1. Arquitetura de Portas e Serviços

Para permitir interceptação de ferramentas sem alterar o comportamento padrão de clientes que apontam para a porta oficial do Ollama (`11434`), dividimos a arquitetura em duas camadas:

```
[ Agentes Paperclip / OpenCode ]
               │
               ▼ (Porta 11434)
┌───────────────────────────────────────┐
│       ollama-router (Proxy Node.js)   │
│   - Tool Call Interceptor             │
│   - Balanced Braces JSON Parser       │
│   - Path Traversal & Root Sanitizer   │
└──────────────────┬────────────────────┘
                   │
                   ▼ (Porta 11435)
┌───────────────────────────────────────┐
│           Ollama Engine Real          │
│   - Dual-GPU Layer Split (CUDA: 0, 1) │
│   - Qwen 2.5 Coder 32B (Q4_K_M)       │
│   - Flash Attention Ativado           │
│   - Contexto Fixo em 32k              │
└───────────────────────────────────────┘
```

O serviço oficial do Ollama escuta internamente em `127.0.0.1:11435`.
O proxy inteligente escuta em `127.0.0.1:11434`.

---

## 2. Variáveis de Ambiente do Ollama e seus Efeitos

Abaixo está o detalhamento de cada variável aplicada na unidade systemd:

| Variável | Valor Configurado | Motivação Técnica |
|---|---|---|
| `OLLAMA_HOST` | `127.0.0.1:11435` | Libera a porta padrão `11434` para o roteador intermediário. |
| `CUDA_VISIBLE_DEVICES` | `0,1` | Garante que o runtime CUDA enxergue e utilize simultaneamente ambas as placas RTX 5060 Ti. |
| `CUDA_DEVICE_ORDER` | `PCI_BUS_ID` | Mantém a ordem física determinística dos barramentos PCIe. |
| `OLLAMA_VULKAN` | `0` | Desativa o backend Vulkan em favor do backend CUDA nativo, muito mais otimizado para tensores NVIDIA. |
| `GGML_VK_VISIBLE_DEVICES`| `""` (vazio) | Previne inicialização acidental de instâncias de aceleração Vulkan. |
| `OLLAMA_CONTEXT_LENGTH` | `16384` | Define a janela de contexto em 16k tokens por slot, otimizando o orçamento de VRAM para concorrência. |
| `OLLAMA_MAX_LOADED_MODELS` | `1` | Proíbe que múltiplos modelos coexistam na VRAM, evitando despejo do modelo principal ou estouro de memória. |
| `OLLAMA_NUM_PARALLEL` | `3` | Permite que até 3 agentes autônomos realizem inferência concorrente em slots paralelos independentes. |
| `OLLAMA_KV_CACHE_TYPE` | `q8_0` | Quantiza o KV Cache em 8-bits, reduzindo o consumo de memória de atenção pela metade sem perda perceptível de precisão. |
| `OLLAMA_FLASH_ATTENTION`| `1` | Ativa algoritmos de atenção particionada em blocos na GPU, reduzindo o consumo de memória do KV Cache em até ~40% e acelerando a inferência. |
| `OLLAMA_KEEP_ALIVE` | `24h` | Mantém o modelo permanentemente residente na VRAM, evitando o descarregamento por inatividade após 5 minutos. |

---

## 3. Arquivo de Serviço Systemd: `ollama.service`

Crie o arquivo em `~/.config/systemd/user/ollama.service`:

```ini
[Unit]
Description=Ollama Service Unified Dual-GPU (32B Abliterated Model)
After=network.target

[Service]
Type=simple
ExecStart=/home/user/.local/bin/ollama serve
Restart=always
RestartSec=3
Environment="PATH=/home/user/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
Environment="OLLAMA_MODELS=/run/media/user/Storage/ollama/models"
Environment="OLLAMA_HOST=127.0.0.1:11435"
Environment="CUDA_VISIBLE_DEVICES=0,1"
Environment="CUDA_DEVICE_ORDER=PCI_BUS_ID"
Environment="OLLAMA_VULKAN=0"
Environment="GGML_VK_VISIBLE_DEVICES="
Environment="OLLAMA_CONTEXT_LENGTH=16384"
Environment="OLLAMA_MAX_LOADED_MODELS=1"
Environment="OLLAMA_NUM_PARALLEL=3"
Environment="OLLAMA_FLASH_ATTENTION=1"
Environment="OLLAMA_KV_CACHE_TYPE=q8_0"
Environment="OLLAMA_KEEP_ALIVE=24h"

[Install]
WantedBy=default.target
```

---

## 4. O Preloader de Modelo: Eliminando a Latência de "Cold-Start"

Quando o Ollama inicializa pela primeira vez, o modelo não fica imediatamente alocado na GPU até que uma requisição real de inferência seja disparada. O carregamento de 20 GB de pesos do disco NVMe para os barramentos das duas GPUs demora entre **25 a 45 segundos**.

Se um agente disparar um heartbeat durante esse intervalo, o cliente pode sofrer timeout. Para resolver isso, implementamos um serviço oneshot de pré-carregamento.

### Script: `/home/user/.local/bin/ollama-preload.sh`
```bash
#!/usr/bin/env bash
set -e

until curl -s http://127.0.0.1:11435/ > /dev/null; do
  sleep 1
done

echo "[Preload] Carregando qwen2.5-coder:32b nas duas GPUs..."
curl -s http://127.0.0.1:11435/api/generate \
  -d '{"model": "qwen2.5-coder:32b", "options": {"num_ctx": 32768}, "keep_alive": "24h"}' > /dev/null

echo "[Preload] qwen2.5-coder:32b 100% residente em VRAM."
```

### Unidade de Serviço: `~/.config/systemd/user/ollama-preload.service`
```ini
[Unit]
Description=Preload Ollama Models into Dual GPUs
After=ollama.service
Requires=ollama.service

[Service]
Type=oneshot
ExecStart=/home/user/.local/bin/ollama-preload.sh
RemainAfterExit=yes

[Install]
WantedBy=default.target
```

---

## 5. Verificação da Alocação no Sistema

Após iniciar os serviços, verifique a distribuição de camadas entre as duas placas executando:

```bash
systemctl --user daemon-reload
systemctl --user restart ollama.service ollama-preload.service
nvidia-smi
```

A saída do `nvidia-smi` deverá mostrar aproximadamente:
- **GPU 0**: ~14.0 GB a 14.5 GB alocados.
- **GPU 1**: ~14.0 GB a 14.5 GB alocados.
- **Status**: 100% das 64 camadas do transformador alocadas em VRAM (zero camadas em CPU/RAM de sistema).
