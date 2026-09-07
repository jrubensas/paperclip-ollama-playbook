# 🛡️ Capítulo 08: Triagem Autônoma e Circuito de Autorrecuperação (Self-Healing Loop)

Este capítulo documenta a descoberta, a causa raiz e a solução arquitetural para o problema de **bloqueio cumulativo de tarefas** em enxames autônomos locais no Paperclip AI, introduzindo o circuito fechado de autorrecuperação gerenciado pelo **Agente Board** (Claude 3.5 Haiku).

---

## 1. O Problema: Tarefas Retidas em `blocked`

Durante a execução prolongada de múltiplos agentes autônomos locais (`CEO`, `CTO`, `Frontend`, `Firmware` e `QA`), observou-se uma degradação na produtividade do enxame:
* Mais de **20 tarefas** foram progressivamente marcadas como `blocked`.
* O pipeline de sprint desacelerou significativamente, acumulando tarefas paradas.

### Análise da Causa Raiz Mecânica: `successful_run_missing_state`

No Paperclip AI, todo agente opera em modo *headless* através do OpenCode (`opencode run --format json`). Ao concluir seu turno:
1. O processo sai com código `0` (`run.status = "succeeded"`).
2. O serviço de Heartbeat do Paperclip (`handleSuccessfulRunHandoff` em `heartbeat.js`) verifica se o agente definiu uma **disposição válida** para a tarefa (`done`, `in_review`, `cancelled` ou `blocked` com apontamento de dependências).
3. Se a tarefa permanece em `in_progress`, o Paperclip emite o alerta interno:
   > *"Paperclip needs a disposition before this issue can continue."*
4. O Paperclip concede exatamente **uma tentativa corretiva** (`DEFAULT_MAX_SUCCESSFUL_RUN_HANDOFF_ATTEMPTS = 1`).
5. Caso o agente encerre novamente sem alterar o status via API/CLI, a rotina de recuperação (`reconcile_successful_run_handoff_missing_state`) **trava a tarefa como `blocked`** e escala para decisão do Board.

---

## 2. A Causa Raiz Comportamental: Vícios dos Modelos Abertos

Modelos locais instruídos por chat (`qwen2.5-coder`) manifestaram três comportamentos disfuncionais em ambientes headless:

1. **Reflexo Conversacional de Chatbot**:
   Ao encontrar uma dúvida ou arquivo ausente, o modelo parava e emitia uma pergunta no terminal:
   - *"Please provide the absolute path to client.go, and I will read it for you."*
   - *"Stripe API key is missing. Do you have a test key? 1. Create test 2. Check existing..."*
   Como não há humano interagindo no terminal headless, o processo terminava sem chamar `paperclip-helper done`.
2. **Caminhos Relativos Incompatíveis**:
   O agente procurava scripts ou arquivos na raiz do repositório (ex.: `./run_all_tests.sh`) em vez de inspecionar a pasta correta (`tests/run_all_tests.sh`), desistindo prematuramente.
3. **Falta de Primitiva de Comunicação com a Governança**:
   Não havia um comando simples para o agente escalar dúvidas legítimas ao Board, forçando-o a emitir texto livre no stdout.

---

## 3. A Solução Arquitetural: Self-Healing Loop

A solução foi implementada em quatro camadas sinérgicas:

```
[Agente Executor (QA/CTO/Firmware)]
       │
       ▼ (Dúvida ou Bloqueio Técnico)
[Opção A: paperclip-helper ask-board] ──► Mapeia para in_review & Notifica Board
       │
       ▼ (Se houver falha de disposition)
[Opção B: Paperclip Watchdog -> BLOCKED]
       │
       ▼
[paperclip-board-triage.service (Listener Contínuo)]
       │
       ▼ (POST /api/agents/{board_id}/wakeup)
[Agente Board (Claude 3.5 Haiku)]
       ├── Inspeciona a tarefa e os comentários da falha
       ├── Resolve caminhos de arquivo ou injeta credenciais mock
       ├── Se entregável concluído: PATCH /issues/:id -> "done"
       └── Se requer continuação: PATCH /issues/:id -> "todo" + Comentário Orientador
       │
       ▼
[Agente Executor Reativado Automaticamente!]
```

---

## 4. Componentes Implementados

### A. Extensão do `paperclip-helper` com `ask-board` e `review`
Adicionados comandos nativos no binário CLI dos agentes (`/home/user/.local/bin/paperclip-helper`):
```bash
# Permite ao agente consultar o Board formalmente, definindo status 'in_review'
paperclip-helper ask-board --question "Qual estratégia de retry devemos adotar para o broker MQTT?"

# Permite ao agente colocar a tarefa em revisão sem travar o pipeline
paperclip-helper review "Entrega inicial pronta para validação de segurança."
```

### B. Guardrails Anti-Chatbot em `AGENTS.md`
Injetados nos arquivos de instruções de todos os agentes executores (CEO, CTO, Frontend, Firmware, QA):
* **Proibição Absoluta de Perguntas em Terminal**: Nenhum turno pode terminar com perguntas abertas no stdout.
* **Investigação Autônoma com `find`**: Obrigatoriedade de busca profunda no workspace antes de alegar ausência de arquivo.
* **Credenciais Mock**: Obrigatoriedade do uso de credenciais simuladas (`STRIPE_API_KEY=sk_test_mock123`) em ambientes locais.
* **Disposição Obrigatória**: Todo turno deve terminar com `paperclip-helper done` ou `paperclip-helper ask-board`.

### C. Protocolo de Triagem do Agente Board
Instrução do Board (`AGENTS.md`) com competência de engenheiro-chefe / diretor:
* Scan de tarefas com `status=blocked`.
* Análise dos logs e histórico de comentários.
* Publicação de parecer orientador e desbloqueio imediato (`status: "todo"` ou `"done"`).
* Elevação do limite de turnos do Board (`maxTurnsPerRun: 35`).

### D. Daemon `paperclip-board-triage.service`
Serviço daemon em Python (`scripts/board_triage_watcher.py`) gerenciado pelo `systemd --user`:
* Monitoramento contínuo da API a cada 15 segundos.
* Cooldown de 60 segundos entre ativações para evitar sobreposição de execuções.
* Despacho automático de wakeups para o Board quando tarefas bloqueadas forem detectadas.

---

## 5. Resultados e Métricas Obtidas

A ativação do circuito de triagem e desbloqueio produziu um impacto imediato na saúde da empresa:

| Métrica | Antes da Triagem | Após a Triagem e Self-Healing | Variação |
|---|---|---|---|
| **Tarefas Bloqueadas (`blocked`)** | 22 | **0** | **-100%** |
| **Tarefas Concluídas (`done`)** | 33 | **49** | **+48.5%** |
| **Tarefas em Execução Paralela** | 1 | **5 simultâneas** | **+400%** |
| **Utilização de GPU (RTX 5060 Ti)** | ~15% | **60% - 64% contínuos** | **Otimizado** |
| **Erros de OOM de Memória** | 0 | **0** | **Estabilidade 100%** |

