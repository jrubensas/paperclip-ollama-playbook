# 01. Arquitetura de Hardware e Gerenciamento de VRAM

Este documento detalha o dimensionamento de memória de vídeo (VRAM), a matemática de contexto (KV Cache), as limitações de barramento e a estratégia de alocação necessária para rodar modelos de 32 bilhões de parâmetros (`Qwen 2.5 Coder 32B`) em ambiente autônomo multi-agente local.

---

## 1. O Hardware em Operação

- **GPUs**: 2x NVIDIA GeForce RTX 5060 Ti (16GB VRAM cada, arquitetura Blackwell / Ada-Lovelace equivalente para workstation compacta).
- **VRAM Total Disponível**: 32 GB (16.384 MB × 2).
- **Barramento de Memória**: 128-bit por GPU (~288 GB/s de largura de banda em GDDR6).
- **PCIe**: 2x slots físicos conectados à CPU (x8/x8 ou x16/x4), gerenciados pela camada de driver proprietário NVIDIA Linux x86_64.
- **Camada de Divisão de Tensores (Tensor/Layer Splitting)**: Gerenciada automaticamente pela biblioteca `llama.cpp` embutida no Ollama via CUDA runtime.

---

## 2. A Matemática da VRAM: Qwen 2.5 Coder 32B (Q4_K_M)

Executar um modelo de 32B não consiste apenas em alocar os pesos na memória de vídeo. O consumo de VRAM é composto por três parcelas cruciais:

$$\text{VRAM}_{\text{Total}} = \text{VRAM}_{\text{Pesos}} + \text{VRAM}_{\text{KV Cache}} + \text{VRAM}_{\text{Overhead CUDA e Buffers}}$$

### A. Pesos do Modelo (Model Weights)
O modelo `qwen2.5-coder:32b` quantizado no formato `Q4_K_M` (4 bits por peso com certas camadas em precisão maior) consome:
- **Tamanho em disco e VRAM**: **~19.8 GB**.
- O Ollama distribui as 64 camadas do modelo entre as duas GPUs:
  - **GPU 0**: ~32 camadas (~9.9 GB de pesos).
  - **GPU 1**: ~32 camadas (~9.9 GB de pesos).

### B. Memória de Atenção (KV Cache)
Em um ambiente autônomo com agentes (Paperclip + OpenCode), os agentes enviam históricos inteiros de conversa, especificações de projeto, listagem de arquivos e regras do sistema. Isso exige uma janela de contexto mínima de **32.768 tokens (32k)**.

A memória necessária para o KV Cache em FP16 (ou com Flash Attention ativado) é calculada por:

$$\text{KV Cache Size} = 2 \times \text{layers} \times \text{hidden\_dim} \times \text{context\_length} \times \text{bytes\_per\_element}$$

Para o Qwen 2.5 32B com janela de 32k e Flash Attention (`OLLAMA_FLASH_ATTENTION=1`):
- **Consumo do KV Cache**: **~7.5 GB a 8.2 GB**.
- Esse cache também é distribuído proporcionalmente entre a GPU 0 e a GPU 1 (~4 GB por placa).

### C. Alocação Total Consolidada
- Pesos: **~19.8 GB**
- KV Cache (32k tokens): **~7.8 GB**
- Context Buffers & CUDA Runtime: **~0.8 GB**
- **VRAM Total Comprometida**: **~28.4 GB** dos **32.0 GB** disponíveis.
- **Margem de Segurança Restante**: **~3.6 GB** de folga dinâmica.

---

## 3. Concorrência e Paralelismo: A Solução com Quantização de KV Cache (`q8_0`)

Inicialmente, com precisão total FP16 no KV Cache e contexto de 32k tokens, cada slot consumia ~8 GB de VRAM. Tentar rodar 2 ou mais agentes simultâneos (`NUM_PARALLEL >= 2`) estourava a VRAM (19.8 GB + 16 GB = 35.8 GB), forçando swap para a RAM de sistema ou disparando erro de OOM CUDA.

### A Estratégia de Otimização para 3 Agentes Simultâneos:
Para destravar inferência paralela em 3 agentes sem perder precisão de código, aplicamos duas mudanças arquiteturais:
1. **Compressão do KV Cache em 8-bits (`OLLAMA_KV_CACHE_TYPE=q8_0`)**:
   - Reduz o consumo de VRAM por token pela metade ($131.072 \text{ bytes/tok} \rightarrow 128\text{ KB/tok}$).
   - Retém 99.99% da precisão matemática de atenção (virtualmente zero perda em relação ao FP16).
2. **Dimensionamento de Contexto em 16.384 tokens (16k)**:
   - Em 16k tokens com `q8_0`, cada slot paralelo consome exatamente **2.0 GB de VRAM**.
   - Para **3 agentes simultâneos**: $3 \times 2.0\text{ GB} = \mathbf{6.0\text{ GB}}$ total de KV Cache.

### Novo Balanço de VRAM Consolidado:
- Pesos do modelo 32B (Q4_K_M): **~19.8 GB**
- KV Cache (3 slots paralelos × 16k tokens em `q8_0`): **~6.0 GB**
- Buffers de ativação e overhead do sistema: **~1.5 GB**
- **VRAM Total Alocada**: **~27.3 GB** dos 32.0 GB disponíveis.
- **Margem de Segurança Livre**: **~4.7 GB** distribuídos entre as duas GPUs.

> [!TIP]
> Com essa configuração (`OLLAMA_NUM_PARALLEL=3`, `OLLAMA_KV_CACHE_TYPE=q8_0` e `OLLAMA_CONTEXT_LENGTH=16384`), 3 agentes autônomos conseguem gerar código e raciocinar simultaneamente na mesma GPU dupla sem enfileiramento ou travamentos.

---

## 4. O Comportamento da GPU: Por que o `nvidia-smi` não marca 100% o tempo todo?

Durante a execução de tarefas pelos agentes, observou-se que a utilização reportada pelo `nvidia-smi` oscila entre picos rápidos de 100% e vales de 20% a 50%. Isso não indica ociosidade nem falta de trabalho, mas a natureza da arquitetura dos Transformadores:

### A. Fase de Prefill / Prompt Ingestion (Compute-Bound)
- O agente envia um prompt de 10.000 tokens (arquivos, diffs, histórico).
- O modelo processa todos esses tokens de uma só vez usando operações de multiplicação de matrizes densas (GEMM).
- **Uso da GPU**: **100% de ocupação dos CUDA Cores**. Alto consumo de energia (TDP máximo).

### B. Fase de Decode / Token Generation (Memory-Bandwidth Bound)
- O modelo gera a resposta token por token de forma autoregressiva.
- A cada novo token gerado, **todos os 20 GB de pesos do modelo precisam ser lidos da VRAM** para calcular uma única linha de ativações.
- Com barramento de 128 bits (~288 GB/s), o tempo gasto é determinado pela velocidade com que a VRAM entrega os dados aos núcleos, e não pelo poder de cálculo dos Tensor Cores.
- **Uso da GPU**: O `nvidia-smi` reporta ~30% a 60% de ocupação dos SMs (Streaming Multiprocessors), pois os núcleos passam a maior parte do tempo ociosa aguardando os dados chegarem da VRAM.
