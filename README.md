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

## Sala local sem internet (Windows)

Um computador da sala pode hospedar o FileShare na rede local. Os outros computadores e celulares acessam pelo navegador, conectados ao mesmo Wi-Fi ou roteador; somente o computador servidor precisa executar o programa.

1. No computador servidor, instale o Node.js 24 LTS.
2. Com internet disponível uma vez, execute `Instalar FileShare Local.bat` para baixar as dependências.
3. Depois, mesmo sem internet, clique duas vezes em `Abrir Servidor FileShare.bat`.
4. A janela mostrará um endereço `http://192.168...`. Compartilhe esse endereço com os demais computadores.
5. Se o Windows Firewall perguntar, permita o acesso em redes privadas. Mantenha a janela aberta enquanto a sala estiver usando o servidor. Pressione Ctrl+C para encerrá-lo.
6. Entre como `admin` usando a senha inicial exibida na primeira inicialização e troque-a em seguida.

O banco e os arquivos enviados ficam persistidos em `data/local` no computador servidor. Faça cópias dessa pasta com o servidor encerrado. O servidor local e o site publicado na Vercel usam bases separadas; dados de um não são sincronizados automaticamente com o outro.
