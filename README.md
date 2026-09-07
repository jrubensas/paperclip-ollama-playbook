# 🚀 Paperclip AI + Ollama Multi-GPU Playbook
### Guia de Engenharia e Arquitetura para Enxames de Agentes Autônomos Locais

Este repositório consolida o conhecimento técnico, diagnósticos profundos, adaptações de código e estratégias de orquestração desenvolvidas para executar o **[Paperclip AI](https://github.com/paperclipai/paperclip)** com modelos de linguagem abertos locais (**Ollama + Qwen 2.5 Coder 32B**) em hardware dedicado de **GPUs Duplas (NVIDIA RTX 5060 Ti 32GB VRAM)**.

---

## 📑 Sumário Executivo

A execução de múltiplos agentes de inteligência artificial de forma autônoma (sprints, criação de código, firmware, frontend e governança) em hardware local impõe desafios severos que não existem em APIs de nuvem centralizadas:

1. **Restrições Físicas de Memória (VRAM)**:
   Modelos de 32B ocupam ~20GB de pesos e ~8GB de KV Cache para contextos de 32k. Isso impede concorrência física direta no modelo e exige serialização determinística (`OLLAMA_NUM_PARALLEL=1`).
2. **Deficiências de Tool Calling em Modelos Abertos**:
   Modelos open-weight tendem a emitir chamadas de ferramentas em formatos markdown, XML ou pseudo-bash sob alta carga de contexto, em vez de JSON estruturado estrito.
3. **Vazamento de Diretório em Sessões Agênticas**:
   O runtime do OpenCode sofria desvios de diretório de trabalho devido à persistência de sessões no SQLite (`~/.local/share/opencode/opencode.db`), gerando arquivos fora do workspace do projeto.
4. **Governança Econômica (Board de Diretores)**:
   Adoção de uma arquitetura híbrida onde 99% do trabalho computacional pesado roda local e gratuito, enquanto aprovações corporativas críticas utilizam um modelo econômico em nuvem sob demanda com **custo zero em repouso ($0 idle)**.
5. **Triagem Autônoma e Circuito de Autorrecuperação (Self-Healing Loop)**:
   Resolução de bloqueios sistemáticos por falta de disposição (`successful_run_missing_state`). Um daemon contínuo vigia tarefas em `blocked` e aciona o Agente Board (Claude Haiku) para esclarecer dúvidas técnicas/mocks e reencaminhar as tarefas aos executores locais automaticamente.

---

## 🏗️ Visão Geral da Arquitetura do Sistema

```
                                  ┌────────────────────────────────────────────────┐
                                  │           Paperclip AI Orchestrator            │
                                  │             (127.0.0.1:3100)                   │
                                  └───────────────┬─────────────────┬──────────────┘
                                                  │                 │
               ┌──────────────────────────────────┘                 └──────────────────────────────┐
               │                                                                                   │
               ▼                                                                                   ▼
┌──────────────────────────────┐                                                    ┌──────────────────────────────┐
│  Agente Board de Diretores   │                                                    │   Agentes de Engenharia      │
│  - Adapter: claude_local     │                                                    │   (CEO, CTO, Dev, Firmware)  │
│  - Engine: Claude CLI        │                                                    │   - Adapter: opencode_local  │
│  - Modelo: Claude Haiku      │                                                    │   - Modelo: qwen2.5-coder:32b│
│  - Heartbeat: Desativado     │                                                    │   - Heartbeat: Hierárquico   │
│  - Acionamento: wakeOnDemand │                                                    └──────────────┬───────────────┘
│  - Custo em repouso: $0.00   │                                                                   │
└──────────────────────────────┘                                                                   │ (OpenAI Protocol)
                                                                                                   ▼
                                                                                    ┌──────────────────────────────┐
                                                                                    │      ollama-router.js        │
                                                                                    │      (Porta 11434)           │
                                                                                    │  - Interceptador de Tools    │
                                                                                    │  - Parser de Chaves Balanceadas│
                                                                                    │  - Sanitizador de Raiz /     │
                                                                                    │  - Gerador de SSE Chunks     │
                                                                                    └──────────────┬───────────────┘
                                                                                                   │ (HTTP Backend)
                                                                                                   ▼
                                                                                    ┌──────────────────────────────┐
                                                                                    │       Ollama Engine          │
                                                                                    │      (Porta 11435)           │
                                                                                    │  - Dual-GPU Tensor Split     │
                                                                                    │  - GPU 0: RTX 5060 Ti (16GB) │
                                                                                    │  - GPU 1: RTX 5060 Ti (16GB) │
                                                                                    │  - Flash Attention Ativo     │
                                                                                    │  - Contexto Fixo: 32.768     │
                                                                                    └──────────────────────────────┘
```

---

## 📚 Índice da Documentação

| Capítulo | Arquivo | Descrição Detalhada |
|---|---|---|
| **01** | [`01_hardware_and_vram.md`](docs/01_hardware_and_vram.md) | Matemática de VRAM, KV Cache, largura de banda de memória (128-bit) e o porquê de `NUM_PARALLEL=1`. |
| **02** | [`02_ollama_dual_gpu_setup.md`](docs/02_ollama_dual_gpu_setup.md) | Configurações de systemd, flags de ambiente CUDA, Flash Attention e o serviço de pré-carregamento. |
| **03** | [`03_tool_interceptor_router.md`](docs/03_tool_interceptor_router.md) | O proxy HTTP inteligente: algoritmos de parsing com chaves balanceadas e correção de chamadas JSON. |
| **04** | [`04_paperclip_orchestration.md`](docs/04_paperclip_orchestration.md) | Orquestração da empresa: CEO em loop de sprint vs. Engenheiros em `wakeOnDemand` e `skipTimer`. |
| **05** | [`05_opencode_adapter_fixes.md`](docs/05_opencode_adapter_fixes.md) | Resolução de vazamento de diretório no OpenCode SQLite e patch do `--dir` no `@paperclipai/adapter-opencode-local`. |
| **06** | [`06_board_governance_claude.md`](docs/06_board_governance_claude.md) | Implementação do Board com Claude Haiku: deliberações formais, teto de turnos (`maxTurns=12`) e $0 em repouso. |
| **07** | [`07_troubleshooting_playbook.md`](docs/07_troubleshooting_playbook.md) | Guia prático de resolução de problemas, comandos de diagnóstico e desbloqueio de tarefas. |
| **08** | [`08_board_triage_self_healing.md`](docs/08_board_triage_self_healing.md) | Circuito fechado de autorrecuperação: triagem autônoma de tarefas bloqueadas com o Agente Board. |

---

## 🛠️ Utilitários Desenvolvidos

Os scripts desenvolvidos estão armazenados no diretório [`scripts/`](scripts/):

1. **[`scripts/ollama-router.js`](scripts/ollama-router.js)**:
   Proxy reverso Node.js com captura ativa de ferramentas, sanitização de caminhos e emulação de chunks de streaming OpenAI.
2. **[`scripts/paperclip-helper`](scripts/paperclip-helper)**:
   CLI criada para que os agentes autônomos consigam:
   - Marcar tarefas como concluídas (`paperclip-helper done [comentário]`).
   - Consultar ou escalar dúvidas ao Board (`paperclip-helper ask-board --question "..."`).
   - Mover tarefa para revisão (`paperclip-helper review [comentário]`).
   - Publicar documentos markdown vinculados à tarefa (`paperclip-helper document <key> <title> <file>`).
   - Fazer upload e registrar artefatos na UI (`paperclip-helper artifact <file> [title]`).
   - Criar novas sub-tarefas com vínculo automático a projetos e metas (`paperclip-helper create-task ...`).
   - Postar comentários estruturados (`paperclip-helper comment "..."`).
3. **[`scripts/board_triage_watcher.py`](scripts/board_triage_watcher.py)**:
   Daemon de vigília contínua que detecta tarefas bloqueadas (`status: blocked`) e dispara a triagem e autorrecuperação pelo Agente Board (Claude 3.5 Haiku).
4. **[`scripts/ollama-preload.sh`](scripts/ollama-preload.sh)**:
   Garante 100% de ocupação dos pesos na VRAM antes do primeiro heartbeat do Paperclip.

---

## ⚙️ Unidades de Serviço do Systemd

Os arquivos de configuração para persistência no Linux estão disponíveis em [`systemd/`](systemd/):

- **[`systemd/ollama.service`](systemd/ollama.service)**: Serviço do Ollama escutando internamente na porta `11435`.
- **[`systemd/ollama-router.service`](systemd/ollama-router.service)**: Serviço do proxy roteador escutando na porta padrão `11434`.
- **[`systemd/ollama-preload.service`](systemd/ollama-preload.service)**: Serviço de carga imediata pós-boot.
- **[`systemd/paperclipai.service`](systemd/paperclipai.service)**: Serviço do servidor Paperclip AI integrado ao catálogo de modelos locais.
- **[`systemd/paperclip-board-triage.service`](systemd/paperclip-board-triage.service)**: Serviço de monitoramento e triagem contínua de tarefas bloqueadas pelo Board.

---

## 🚀 Como Replicar este Ambiente

### 1. Requisitos de Sistema
- Sistema Operacional: Linux (Debian/Ubuntu/Arch/Fedora).
- Drivers NVIDIA proprietários com CUDA 12+.
- Duas placas de vídeo NVIDIA com no mínimo 16GB VRAM cada (total 32GB+).
- Node.js v20+ e Python 3.10+.
- Ollama instalado via script oficial.

### 2. Passo a Passo de Instalação

```bash
# 1. Clone o repositório
git clone https://github.com/jrubensas/paperclip-ollama-playbook.git
cd paperclip-ollama-playbook

# 2. Instale os scripts em ~/.local/bin
cp scripts/ollama-router.js ~/.local/bin/
cp scripts/paperclip-helper.js ~/.local/bin/paperclip-helper
cp scripts/ollama-preload.sh ~/.local/bin/
chmod +x ~/.local/bin/ollama-router.js ~/.local/bin/paperclip-helper ~/.local/bin/ollama-preload.sh

# 3. Baixe o modelo 32B no Ollama
ollama pull qwen2.5-coder:32b

# 4. Instale e ative as unidades de serviço do systemd
mkdir -p ~/.config/systemd/user
cp systemd/*.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now ollama.service ollama-preload.service ollama-router.service paperclipai.service

# 5. Aplique o patch de diretório no adapter do OpenCode
# (Consulte docs/05_opencode_adapter_fixes.md para detalhes da linha exata)
```

---

## 📊 Principais Lições Aprendidas

1. **Agentes Locais precisam de Roteamento Rígido**: Modelos de 32B são altamente competentes para programar, mas não foram treinados para lidar com o overhead de parsing de chamadas quando submetidos a agentes reativos. Um proxy de interceptação é mandatório.
2. **Concorrência em LLM Local é Gerenciada por Fila, Não por Thread**: Tentar rodar múltiplos agentes em paralelo na mesma GPU destrói a vazão por saturação do barramento de memória. O segredo está em agentes especialistas ativados sob demanda (`wakeOnDemand`).
3. **Persistência de Sessão Requer Isolamento Explícito de Caminho**: Runtimes como o OpenCode memorizam o histórico de diretórios em banco de dados local. A injeção forçada de `--dir <cwd>` é essencial para evitar dispersão de arquivos pelo sistema de arquivos.

---

## 👤 Autor
**J. Rubens** ([@jrubensas](https://github.com/jrubensas))  
Documentação técnica desenvolvida durante a implementação e homologação da plataforma DevBoost com agentes autônomos locais.
