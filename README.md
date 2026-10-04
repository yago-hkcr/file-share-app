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
