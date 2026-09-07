# Base de Conhecimento e Lições Aprendidas: Cluster Autônomo Paperclip + Ollama

Este documento consolida os princípios operacionais, armadilhas técnicas identificadas e melhores práticas estabelecidas durante o desenvolvimento e estabilização do ecossistema Paperclip em ambiente Dual GPU.

---

## 1. Topologia de Hardware e Eficiência de VRAM

| Componente | Especificação | Função / Papel |
|---|---|---|
| **GPU 0** | NVIDIA RTX 5060 Ti 16GB | `qwen2.5-coder:32b` (Layers principais) + `qwen2.5-coder:7b` |
| **GPU 1** | NVIDIA RTX 5060 Ti 16GB | `qwen2.5-coder:32b` (Layers secundários) + Saída Display |
| **Cloud Board** | Claude 3.5 Haiku | Agente Board (Governança, triagem, custo zero em repouso) |

### Lições Críticas:
1. **Controle de Paralelismo no Ollama (`OLLAMA_NUM_PARALLEL=1`)**:
   - Em GPUs com barramento de 128-bit, carregar instâncias paralelas dentro do mesmo processo satura a largura de banda de memória e causa OOM.
   - O enfileiramento e paralelismo assíncrono devem ser geridos externamente pelo proxy HTTP `ollama-router.js`.
2. **Flash Attention e KV Cache**:
   - `OLLAMA_FLASH_ATTENTION=1` e `OLLAMA_KV_CACHE_TYPE=q8_0` garantem estabilidade de VRAM mesmo com contextos longos (até 32k tokens).

---

## 2. Orquestração e Ciclo de Vida do Paperclip

### A. Regra de Disposição de Tarefas (`invalid_issue_disposition`)
O Paperclip proíbe que um agente coloque uma tarefa em `in_review` se não houver um "caminho de revisão ativo" (`review_path`).
- Se o agente tenta alterar o status sem criar uma interação prévia, a API retorna **HTTP 422**.
- Solução: Toda transição para `in_review` deve ser acompanhada de uma interação válida (`ask_user_questions` ou `request_confirmation`).

### B. Conformidade Estrita de Schemas Zod (`ask_user_questions`)
- O schema da API exige:
  ```json
  {
    "kind": "ask_user_questions",
    "continuationPolicy": "wake_assignee",
    "payload": {
      "version": 1,
      "questions": [
        {
          "id": "q1",
          "prompt": "Texto da pergunta (string)",
          "selectionMode": "single",
          "options": [
            { "id": "opt1", "label": "Opção 1" },
            { "id": "opt2", "label": "Opção 2", "freeText": true }
          ]
        }
      ]
    }
  }
  ```
- Estruturas alternativas (ex: `{ question, type }`) provocam **HTTP 400 Validation Error**.

### C. Prevenção de Loops de Turnos e Churn
1. **Sanitização de Argumentos**: LLMs locais podem tentar passar flags de CLI diretamente como argumentos (`--prompt`, `--options`). O parser do CLI do agente deve filtrar essas strings via Regex antes de persistir o comentário.
2. **Guarda de Idempotência**: O helper CLI deve checar se a tarefa já está em `in_review` ou `done` antes de criar comentários repetidos.

### D. Autoridade `local-board` vs Isolamento de Agentes (`cross_issue_influence`)
- Ao disparar o Agente Board via wakeup/heartbeat, o Paperclip não atribui um `sourceIssueId` ao run.
- Se o agente enviar `Authorization: Bearer $PAPERCLIP_API_KEY`, o Paperclip o reconhece como `actor.type === "agent"` e impõe verificação estrita de escrita cruzada: qualquer tentativa de comentar ou alterar o status de outra issue falha com **HTTP 403** (`cross_issue_influence_run_context_required`).
- **Regra de Ouro**: Chamadas da governança vindas de `localhost` devem **omitir** os cabeçalhos `Authorization: Bearer` e `X-Paperclip-Run-Id`. Sem eles, o Paperclip promove a requisição para a autoridade `local-board` (Admin), que possui permissão irrestrita para gerir e desbloquear tarefas em toda a empresa.

---

## 3. Comportamento e Guardrails de Agentes Autônomos

1. **Anti-Chatbot Guardrails**:
   - Agentes autônomos executados via OpenCode não possuem operador interativo no terminal.
   - Proibido emitir perguntas abertas no stdout; todas as decisões devem usar mocks de teste ou ferramentas dedicadas (`paperclip-helper ask-board`).
2. **Diferenciação de Escopo do CEO**:
   - Tarefas operacionais de acompanhamento (ex: "Monitor Sprint Velocity") são de competência do CEO e devem ser concluídas com `paperclip-helper done`.
   - `ask-board` deve ser acionado apenas para deliberações de negócio ou bloqueios intransponíveis.
3. **Triagem Autônoma em Duas Camadas (Self-Healing Watcher v2)**:
   - **Camada 1 (Direta/Local)**: O daemon `paperclip-board-triage.service` roda a cada 15s e resolve instantaneamente timeouts de disposição (`missing_disposition`) e dependências satisfeitas, restaurando-as para `todo` como `local-board` sem acionar LLMs ou gastar tokens.
   - **Camada 2 (Deliberação do Board)**: Tarefas com aprovações pendentes ou interações formais são escaladas para o Claude 3.5 Haiku, que atua como arquiteto/diretor emitindo pareceres e decisões vinculadas.
