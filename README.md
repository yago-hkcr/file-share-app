# FileShare

Aplicacao web de compartilhamento de arquivos com contas aprovadas por administrador, salas publicas ou privadas, upload, download e chat.

## Executar localmente

```powershell
npm install
node server.js   # le DATABASE_URL do .env.local
```

Abra `http://localhost:3000`.

Acesso inicial do administrador: `admin` / `admin123`. Altere a senha depois do primeiro acesso.

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
