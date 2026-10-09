# FileShare

Aplicacao web de compartilhamento de arquivos com contas aprovadas por administrador, salas publicas ou privadas, upload, download e chat.

O painel tem tres secoes:

- **Salas** — crie salas temporarias, envie arquivos e converse com o grupo;
- **Coletas** — peca arquivos a outras pessoas com links individuais, prazo e itens;
- **Meu Acervo** — guarde arquivos importantes em espacos privados com prateleiras e anotacoes.

## Executar localmente (modo mais simples, sem banco externo)

```powershell
npm run local:install   # uma vez, com internet
npm run local:start     # banco local em data/local
```

Abra `http://localhost:3000`.

Alternativa com banco Neon: crie um `.env.local` com `DATABASE_URL` e execute
`npm install` uma vez e depois `node server.js` (le `DATABASE_URL` do `.env.local`).

Configure `ADMIN_PASSWORD` e `SESSION_SECRET` no ambiente antes da inicialização. `ADMIN_PASSWORD` cria a conta administrativa `admin` apenas se ainda não houver uma conta; instalações existentes mantêm a senha cadastrada. `SESSION_SECRET` protege os cookies de sessão e deve permanecer estável entre reinicializações.

## Deploy (Vercel + Neon)

Todos os dados (contas, salas, mensagens, arquivos) ficam no Postgres do Neon, acessado via `DATABASE_URL`
(integracao Neon da Vercel). As tabelas sao criadas automaticamente no primeiro acesso.
Como a Vercel nao tem disco persistente, os arquivos sao gravados no proprio Postgres; a Vercel limita o
corpo de uma requisicao a ~4,5 MB, entao o limite de envio e de 4 MB por vez. Para arquivos maiores,
use Vercel Blob com upload direto do navegador.

## Seguranca

Defina `SESSION_SECRET` em producao. Nunca publique `.env`, `data/database.sqlite` ou arquivos enviados.

## Sala local sem internet

Um computador da sala hospeda o FileShare, enquanto os demais entram pelo navegador na mesma rede Wi-Fi ou cabeada. O acesso pela rede começa desligado e só uma conta ADM pode ativá-lo no painel.

1. Em qualquer computador Windows/macOS/Linux que será o servidor, instale o Node.js 24 LTS.
2. Com internet disponível uma vez, prepare os componentes: clique em `Instalar FileShare Local.bat` no Windows ou execute `npm run local:install` no macOS/Linux.
3. Depois, mesmo sem internet, inicie o FileShare: clique em `Abrir Servidor FileShare.bat` no Windows ou execute `npm run local:start` no macOS/Linux.
4. O serviço começa fechado para a rede. Entre como `admin` com a senha inicial exibida no terminal e troque-a.
5. No painel ADM, clique em `Servidor da sala` e escolha `Iniciar servidor`. Só então os outros computadores poderão entrar pelo endereço mostrado. Apenas ADM pode iniciar ou parar o acesso.
6. Se o Firewall perguntar, permita o acesso em redes privadas. Mantenha o computador ligado e o processo aberto.

O banco e os arquivos enviados ficam persistidos em `data/local` no computador servidor. Faça cópias dessa pasta com o servidor encerrado. O servidor local e o site publicado na Vercel usam bases separadas; dados de um não são sincronizados automaticamente com o outro.

## Protecao contra arquivos corrompidos

Commits frequentes em branches salvam cada etapa do trabalho. Alem disso, o
repositorio tem um hook de pre-commit versionado em `.githooks/pre-commit`
que bloqueia arquivos truncados (a assinatura do incidente de 08/10/2026:
arquivos com exatamente 1.506 bytes) e valida a sintaxe dos arquivos `.js`.
O caminho ja vem configurado (`core.hooksPath = .githooks`); para reconfigurar:

```powershell
git config core.hooksPath .githooks
```

Em um caso excepcional de arquivo legitimo ser bloqueado, use `git commit --no-verify`.
