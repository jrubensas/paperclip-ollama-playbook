# Relatório Consolidado de Telemetria — 1 Hora de Carga Real
**Data:** 2026-09-06  
**Duração da Amostragem:** 55,1 minutos (~1 hora contínua)  
**Ambiente:** Paperclip AI + Ollama Multi-GPU (Dual NVIDIA RTX 5060 Ti 32GB VRAM)  
**Modelo em Avaliação:** `qwen2.5-coder:32b` (Q4_K_M) com Flash Attention ativo  

---

## 1. Sumário Executivo de Volume
Durante 1 hora de operação autônoma contínua dos agentes (CEO, CTO, Frontend e QA):
* **Requisições de Inferência Atendidas:** **74 execuções completas**
* **Tokens de Prompt (Entrada):** **362.040 tokens**
* **Tokens Gerados (Saída de Código):** **415.529 tokens**
* **Volume Total de Tokens:** **777.569 tokens** (~0,8 milhão de tokens processados)
* **Velocidade Média de Geração:** ~271 tokens/segundo (agregado com prompt evaluation paralelo)
* **Taxa de Sucesso:** **100%** (zero erros de OOM, zero timeouts)

---

## 2. Distribuição Estatística de Contexto Utilizado (Tokens por Turno)
*Janela Máxima Alocada:* **16.384 tokens (16k)**

| Métrica | Tokens Reais | % da Janela Utilizada | Interpretação Técnica |
| :--- | :--- | :--- | :--- |
| **Mínimo** | 1.823 tokens | 11,1% | Invocação simples de comandos de terminal |
| **P50 (Mediana)** | **9.108 tokens** | **55,6%** | Metade das tarefas consome ~9k tokens |
| **P90** | **13.850 tokens** | **84,5%** | Tarefas de integração de múltiplos arquivos |
| **P95** | **15.623 tokens** | **95,4%** | Tarefas complexas de QA e refatoração |
| **Pico Máximo (Max)** | **16.362 tokens** | **99,9%** | Limite superior da janela de 16k |
| **Média Geral** | **8.741 tokens** | **53,3%** | Cerca de metade da janela de 16k |

---

## 3. Comportamento Térmico e de VRAM das GPUs
* **GPU 0:** 13.724 MiB utilizados (Pico: 13.724 MiB, ~2.587 MiB livres) | Temp: 63°C
* **GPU 1:** 14.414 MiB utilizados (Pico: 14.492 MiB, ~1.819 MiB livres) | Temp: 61°C
* **Folga Mínima de Segurança Registrada:** **~1.819 MiB** na GPU 1 (que também hospeda buffers de display do sistema).

---

## 4. Parecer de Engenharia para Inclusão de Mais Agentes

### Diagnóstico da Configuração Atual (`3 slots`, `q8_0`, `16k context`):
* A configuração atual é o **ponto de equilíbrio ideal (sweet spot)** para o modelo 32B com precisão FP16-like no KV Cache.
* O pico máximo registrado de **16.362 tokens** (P95 em 15.6k) comprova que **a janela de 16k não pode ser reduzida para 10k ou 12k**: se fosse reduzida, cerca de 10% das inferências sofreriam corte abrupto de contexto.

### Podemos expandir para 4 agentes em paralelo mantendo o Qwen 32B?
* **Com `q8_0` (atual):** **Não é recomendado**. Um 4º slot em `q8_0` exigiria mais 1.024 MiB na GPU 1, reduzindo a folga livre para ~795 MiB, o que entraria na zona de perigo de OOM durante picos de cálculo matricial (GEMM prefill).
* **Com `q4_0`:** **SIM, com total segurança**.
  * Se alterarmos `OLLAMA_KV_CACHE_TYPE=q4_0`:
    * O consumo de cada slot de 16k cai de 2,0 GB para apenas **1,0 GB**.
    * **4 slots paralelos em `q4_0` consumirão 4,0 GB de KV Cache total** (menos do que os 3 slots atuais em `q8_0` que consomem 6,0 GB).
    * VRAM Total: 19,8 GB (pesos) + 4,0 GB (KV cache) = **23,8 GB** (sobrando ~3,5 GB livres em cada GPU).
    * Isso permite rodar **4 agentes simultâneos** com contexto pleno de 16k e folga confortável nas duas GPUs.
