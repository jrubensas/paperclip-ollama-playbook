# 04. Orquestração de Agentes e Estratégia de Heartbeats

Neste documento descrevemos o funcionamento da orquestração multi-agente do **Paperclip AI**, o problema de contenção de recursos em LLMs locais e a arquitetura hierárquica implementada para alcançar operação contínua e estável.

---

## 1. O Conceito de Empresa Autônoma no Paperclip AI

O Paperclip estrutura o desenvolvimento de software através de uma hierarquia corporativa completa:
- **Company**: A entidade organizacional mãe (ex: `DevBoost`).
- **Goal**: O objetivo macro do produto (ex: `Lançar plataforma IoT com firmware ESP32-S3 e marketplace SvelteKit`).
- **Project**: A iniciativa de engenharia com seu workspace dedicado no sistema de arquivos.
- **Agents**: Trabalhadores autônomos com papéis definidos (CEO, CTO, Engenheiro de Frontend, Especialista em Firmware, Engenheiro de QA, Board).
- **Issues / Tasks**: Unidades de trabalho com estados (`todo`, `in_progress`, `in_review`, `done`), vinculadas a metas e projetos.
- **Heartbeats & Runs**: Ciclos em que o motor do Paperclip desperta um agente, injeta o contexto da empresa e executa seu adapter.

---

## 2. O Desafio da Concorrência de Agentes com LLM Local

Em ambientes que utilizam APIs em nuvem com limites altos (ex: OpenAI tier 4 ou Anthropic Enterprise), é viável permitir que 10 ou 20 agentes executem seus loops de raciocínio a cada 60 segundos de forma assíncrona.

Porém, em uma infraestrutura **on-premise local** com LLM de 32B e `OLLAMA_NUM_PARALLEL=1`:
1. Cada inferência de um agente leva entre **15 a 60 segundos** (leitura de contexto + geração de código).
2. Se 5 agentes (CEO, CTO, Frontend, Firmware, QA) tiverem temporizadores periódicos rodando a cada minuto:
   - Os 5 agentes disparam requisições quase simultâneas.
   - 4 requisições caem na fila do proxy.
   - O tempo de espera excede os timeouts do runtime (OpenCode / Paperclip), causando falhas em cascata: `Run failed: Connection aborted` ou `Agent execution timed out`.
   - A GPU fica sobrecarregada com alternâncias de contexto.

---

## 3. A Solução: Arquitetura Hierárquica "Orquestrador vs. Sob Demanda"

Para obter máxima eficiência e estabilidade, dividimos os agentes em duas categorias operacionais distintas:

```
┌────────────────────────────────────────────────────────┐
│                      CEO AGENT                         │
│  - Intervalo: 180s                                     │
│  - skipTimerWhenNoActionableWork: false                │
│  - wakeOnDemand: true                                  │
│                                                        │
│  Função: Analisar o Goal, auditar o progresso geral,   │
│          criar tarefas no backlog e atribuir aos       │
│          especialistas adequados com prioridades.      │
└───────────────────────────┬────────────────────────────┘
                            │ (Criação de Tarefas)
        ┌───────────────────┼───────────────────┐
        ▼                   ▼                   ▼
┌───────────────┐   ┌───────────────┐   ┌───────────────┐
│   CTO AGENT   │   │ FRONTEND ENG  │   │ FIRMWARE SPEC │
│ (wakeOnDemand)│   │ (wakeOnDemand)│   │ (wakeOnDemand)│
│ (skipTimer)   │   │ (skipTimer)   │   │ (skipTimer)   │
└───────────────┘   └───────────────┘   └───────────────┘
```

### Configurações Detalhadas:

#### A. O Agente Orquestrador (CEO)
- **Modelo**: `ollama/qwen2.5-coder:32b`
- **Adapter**: `opencode_local`
- **Heartbeat**:
  ```json
  {
    "enabled": true,
    "intervalSec": 180,
    "wakeOnDemand": true,
    "maxConcurrentRuns": 1,
    "skipTimerWhenNoActionableWork": false
  }
  ```
- **Comportamento**: A cada 3 minutos, o CEO desperta. Ele verifica se as metas estão avançando, avalia relatórios de QA e, caso existam requisitos pendentes, quebra a meta em tarefas técnicas específicas e as distribui.

#### B. Os Agentes Especialistas de Execução (CTO, Frontend, Firmware, QA)
- **Modelo**: `ollama/qwen2.5-coder:32b`
- **Adapter**: `opencode_local`
- **Heartbeat**:
  ```json
  {
    "enabled": true,
    "intervalSec": 300,
    "wakeOnDemand": true,
    "maxConcurrentRuns": 1,
    "skipTimerWhenNoActionableWork": true
  }
  ```
- **Comportamento**:
  - Quando **não há tarefas atribuídas** com status `todo` ou `in_progress`, o parâmetro `skipTimerWhenNoActionableWork: true` suprime completamente o timer periódico. O agente permanece em repouso (zero uso de VRAM e zero requisições de inferência).
  - No momento em que o CEO ou o usuário atribui uma tarefa a ele, o evento `wakeOnDemand: true` acorda imediatamente o agente.
  - O agente executa a tarefa, implementa os arquivos no workspace, registra seus artefatos, marca a tarefa como `done` e retorna ao repouso.

---

## 4. Benefícios Práticos da Abordagem

1. **Zero Contenção de GPU**: As tarefas são processadas sequencialmente na ordem em que são distribuídas.
2. **Priorização Racional**: O tempo de GPU é 100% dedicado ao código da tarefa ativa, sem interrupções de outros agentes perguntando "há algo para eu fazer?".
3. **Economia de Energia e Menor Temperatura**: Nos períodos entre tarefas, a GPU permanece com consumo de energia em repouso (~10W por placa contra ~160W em carga total).
