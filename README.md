# FileShare

Aplicacao web de compartilhamento de arquivos com contas aprovadas por administrador, salas publicas ou privadas, upload, download e chat.

## Executar localmente

```powershell
npm install
node server.js
```

Abra `http://localhost:3000`.

Acesso inicial do administrador: `admin` / `admin123`. Altere a senha depois do primeiro acesso.

## Deploy

O projeto inclui `vercel.json` e exporta o Express para execucao serverless. Em Vercel, o banco SQLite e os uploads usam `/tmp`, que e efemero. Para dados persistentes em producao, substitua o armazenamento local por um banco e storage gerenciados.

## Seguranca

Defina `SESSION_SECRET` em producao. Nunca publique `.env`, `data/database.sqlite` ou arquivos enviados.
