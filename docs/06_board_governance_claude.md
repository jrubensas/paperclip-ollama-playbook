# 06. Governança Híbrida: O Agente do Conselho (Board) com Claude Haiku

Em organizações autônomas, os agentes de engenharia não devem tomar decisões de infraestrutura, arquitetura ou orçamento sem um processo formal de governança. O Paperclip implementa o conceito de **Board of Directors (Conselho de Administração)** para desempenhar esse papel deliberativo.

Este documento explica por que a governança com modelos locais apresentava falhas de conformidade e como a migração para uma arquitetura híbrida com **Claude Haiku CLI** resolveu a estabilidade com custo residual de frações de centavo.

---

## 1. O Papel do Agente Board no Paperclip

O Board atua no topo da governança corporativa:
1. **Aprovação de Planos de Arquitetura**: Quando o CEO ou CTO propõe uma mudança estrutural (ex: alterar o banco de dados de PostgreSQL para TimescaleDB, ou definir a stack do frontend em SvelteKit).
2. **Desbloqueio de Tarefas**: Quando um agente marca uma issue como bloqueada por decisão de negócios.
3. **Auditoria e Compliance**: Garantir que as diretrizes do Goal principal estão sendo respeitadas pelos agentes de desenvolvimento.

---

## 2. Por que o Board Falhava com Modelos Locais

Inicialmente, tentou-se rodar o Board no mesmo modelo local `qwen2.5-coder:32b`:
- **Instabilidade no Protocolo de Governança**:
  O prompt do Board contém dezenas de regras de deliberação corporativa formal. Modelos voltados primariamente para programação tendem a tentar escrever scripts em bash ou gerar código mesmo quando a instrução é exclusivamente deliberar, emitir voto ou responder em formato textual executivo.
- **Loops Reflexivos**: O modelo local entrava em auto-questionamentos sobre permissões ou tentava inspecionar diretórios do sistema sem necessidade.
- **Contenção de GPU**: Se o Board rodava no modelo local, ele competia diretamente com o CEO ou com os engenheiros de desenvolvimento pelos mesmos recursos de VRAM.

---

## 3. A Solução Híbrida: Claude Haiku via CLI (`claude_local`)

Implementamos uma estratégia em que o trabalho pesado de código (criação de dezenas de arquivos, compilação, depuração) roda **100% local e gratuito nas duas GPUs RTX 5060 Ti**, enquanto a deliberação de governança utiliza a inteligência refinada do **Claude Haiku** da Anthropic.

### A. Vantagens do Claude Haiku para Governança
1. **Custo Extremamente Baixo**: Haiku custa apenas US$ 0,25 por milhão de tokens de entrada e US$ 1,25 por milhão de tokens de saída.
2. **Rigor em Seguir Instruções**: Obediência impecável a esquemas de votação e deliberação corporativa.
3. **Sem Impacto na VRAM Local**: A inferência roda nos servidores da Anthropic via API, deixando as 2 GPUs totalmente livres para os engenheiros locais.

---

## 4. Otimização Econômica: Custo Zero em Repouso ($0 Idle)

Uma preocupação central era garantir que o agente Board não gerasse custos recorrentes desnecessários quando não houvesse nada para aprovar.

Para isso, configuramos o agente Board com **Heartbeat Periódico Desativado** e acionamento estritamente orientado a eventos:

```json
{
  "name": "Board",
  "role": "general",
  "title": "Board of Directors / Corporate Approver",
  "adapterType": "claude_local",
  "adapterConfig": {
    "engine": "cli",
    "command": "claude",
    "model": "haiku",
    "maxTurnsPerRun": 12,
    "dangerouslySkipPermissions": true,
    "heartbeat": {
      "enabled": false,
      "wakeOnDemand": true,
      "maxConcurrentRuns": 1
    }
  }
}
```

### Como Funciona na Prática:
1. **Em Repouso**: O timer está desligado (`enabled: false`). O Board passa dias sem fazer uma única chamada de API. **Custo: US$ 0,00**.
2. **Quando Acionado (`wakeOnDemand: true`)**:
   - Um agente marca uma tarefa para aprovação do Conselho ou menciona o Board em um comentário.
   - O Paperclip desperta o Board instantaneamente.
   - O Claude Haiku processa a solicitação em segundos, aprova ou comenta a diretriz, encerra a execução e volta imediatamente ao estado ocioso.
   - **Custo por Deliberação**: ~US$ 0,0005 (menos de meio centavo de dólar por aprovação).
3. **Proteção contra Loops (`maxTurnsPerRun: 12`)**:
   - Limita rigorosamente o número de turnos a 12 iterações máximas, impedindo qualquer risco de consumo indesejado de saldo.
