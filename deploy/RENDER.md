# Render Free + Blob + Cloudflare — Arquive no ar sem Vercel

Este é o caminho em produção para manter o site fora da Vercel e sem depender
 do PC ligado:

```text
Navegador ──► Cloudflare DNS ──► Render Free (Node/Express)
                    │                    ├── metadados no Postgres/Supabase
                    │                    └── bytes no Vercel Blob
                    └── status.arquive.online (Worker + cron)
```

O Render serve HTML, APIs e metadados. Os bytes continuam no Blob gerenciado
(`STORAGE_PROVIDER=blob`). O domínio principal não usa mais o túnel local.

## Estado atual (produção)

| Item | Valor |
| --- | --- |
| Origem | Render Free, serviço `arquive`, região Frankfurt |
| Domínio | `www.arquive.online` → CNAME `arquive.onrender.com` (DNS only) |
| Apex | `arquive.online` → CNAME Render, que responde 301 para `www` |
| TLS | Certificado do Render, custom domains **verified** |
| Storage | `STORAGE_PROVIDER=blob` + `BLOB_READ_WRITE_TOKEN` |
| Keepalive | GitHub Actions a cada 5 min **e** Worker cron a cada 5 min |
| Status | <https://status.arquive.online> (Cloudflare Worker, independente do Render) |
| Alertas | Workflow abre/atualiza issue `arquive-incident` no GitHub quando falha |
| Health | `GET /health` com `status`, `storage`, `uptime_seconds` e `commit` |

> O túnel `origin.arquive.online` e o Worker antigo `calm-base-7b71` foram
> removidos. O site não depende mais do computador local.

## Custos e limites

| Peça | Free tier | Observação |
| --- | --- | --- |
| Render Web Service | 750 h/mês, 512 MB | Dois keepalives independentes evitam o sono de 15 min |
| Cloudflare Worker | 100k req/dia + cron | Serve a página de status e acorda o Render |
| Vercel Blob | cota atual | Funciona, mas é a peça que ainda depende da conta Vercel |
| Postgres/Supabase | cota atual | Banco já existente |
| Cloudflare R2 | 10 GB, egress US$ 0 | Migração opcional para remover o Blob (pode pedir cartão) |
| Backblaze B2 | 10 GB, 1 GB/dia | Alternativa S3 sem R2 |

## Migração opcional para R2/S3 (remove o Vercel Blob)

As seções abaixo descrevem o caminho opcional S3. Não são necessárias para o
funcionamento atual; hoje a produção usa Blob.


## 1. Criar o bucket

### Opção A — Cloudflare R2 (melhor: egress zero)

1. Cloudflare Dashboard → **R2** → **Create bucket** → nome `arquive-files`;
   mantenha **privado**.
2. **Manage R2 API Tokens** → **Create API token** → permissão
   **Object Read & Write** para esse bucket.
3. Guarde:
   - `S3_ENDPOINT=https://<ACCOUNT_ID>.r2.cloudflarestorage.com`
   - `S3_REGION=auto`
   - `S3_BUCKET=arquive-files`
   - `S3_ACCESS_KEY_ID=...`
   - `S3_SECRET_ACCESS_KEY=...`
4. No bucket → **Settings → CORS Policy**, cole
   [`deploy/r2-cors.json`](r2-cors.json).

### Opção B — Backblaze B2 (sem cartão, 10 GB)

1. Crie um bucket **private**.
2. Crie uma **Application Key** com acesso ao bucket.
3. Use:
   - `S3_ENDPOINT=https://s3.<região>.backblazeb2.com` (ex.:
     `https://s3.us-west-004.backblazeb2.com`)
   - `S3_REGION=<região>` (ex.: `us-west-004`)
   - `S3_BUCKET=<bucket>`
   - `S3_ACCESS_KEY_ID=<keyID>`
   - `S3_SECRET_ACCESS_KEY=<applicationKey>`
4. Configure CORS no bucket com a mesma política do R2 (origem
   `https://www.arquive.online`, métodos `GET`, `HEAD`, `PUT`).

> O mesmo adaptador funciona com MinIO, Storj (gateway S3) e AWS S3. O bucket
> deve ser privado; o app assina URLs de curta duração.

## 2. Subir no Render

1. Crie uma conta no [Render](https://render.com) e conecte o GitHub.
2. **New → Blueprint** → escolha `yago-hkcr/file-share-app`.
3. O Render lê o [`render.yaml`](../render.yaml) e cria o serviço Docker
   `arquive` no plano **free**.
4. Preencha os valores marcados como secretos:

| Variável | Valor |
| --- | --- |
| `DATABASE_URL` | URL direta do Neon (`DATABASE_URL_UNPOOLED`) |
| `S3_ENDPOINT` | endpoint do bucket |
| `S3_REGION` | `auto` no R2 ou a região do B2 |
| `S3_BUCKET` | nome do bucket |
| `S3_ACCESS_KEY_ID` | chave do bucket |
| `S3_SECRET_ACCESS_KEY` | segredo do bucket |
| `SESSION_SECRET` | o mesmo da Vercel (ou uma string aleatória longa) |
| `CRON_SECRET` | segredo do cron |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` | os mesmos da Vercel |
| `VAPID_SUBJECT` | `mailto:contato@arquive.online` |
| `GOOGLE_DRIVE_CLIENT_ID` / `SECRET` | os mesmos da Vercel, se usar Drive |
| `RESEND_API_KEY` / `MAIL_FROM` | se usar e-mail |
| `ADMIN_PASSWORD` | senha inicial, se o banco ainda não tiver admin |

Não adicione `BLOB_READ_WRITE_TOKEN` no Render: ele só é usado uma vez, na
migração, e não deve ficar no servidor novo.

O `render.yaml` já define `IS_HOSTED=1`, `STORAGE_PROVIDER=s3`,
`S3_FORCE_PATH_STYLE=true`, `DATABASE_SSL=true` e `APP_BASE_URL`.

## 3. Migrar os arquivos antigos do Blob

Faça isso na sua máquina, com o projeto e um `.env` preenchido (o script lê
`.env` automaticamente; há um modelo em [`s3.env.example`](s3.env.example)):

```dotenv
DATABASE_URL_UNPOOLED=postgresql://...
BLOB_READ_WRITE_TOKEN=vercel_blob_...
STORAGE_PROVIDER=s3
S3_ENDPOINT=https://<ACCOUNT_ID>.r2.cloudflarestorage.com
S3_REGION=auto
S3_BUCKET=arquive-files
S3_ACCESS_KEY_ID=...
S3_SECRET_ACCESS_KEY=...
S3_FORCE_PATH_STYLE=true
```

```bash
npm install
npm run migrate:storage -- --dry-run
npm run migrate:storage
```

O script:

- lê os caminhos reais de `files`, `personal_library_items` e
  `file_collection_uploads`;
- baixa cada objeto do Blob e grava no bucket;
- confere o tamanho gravado contra o tamanho do Blob;
- é idempotente (pode rodar de novo; pula o que já existe).

No teste real deste projeto: **77 objetos, 362 MB, 0 falhas**.

Depois da migração, remova `BLOB_READ_WRITE_TOKEN` do `.env` local e do
ambiente. O Blob antigo pode ser desligado quando você confirmar que os
downloads estão funcionando.

## 4. Domínio (estado atual na Cloudflare)

No Render, serviço `arquive` → **Settings → Custom Domains**, os dois domínios
estão **verified**:

1. `www.arquive.online` → CNAME `arquive.onrender.com`, **DNS only** (sem
   proxy laranja). O TLS é emitido pelo Render.
2. `arquive.online` → CNAME `arquive.onrender.com`, **DNS only**. O Render
   responde `301` para `https://www.arquive.online` preservando path e query.
3. `status.arquive.online` → CNAME `www.arquive.online`, **proxied**, com a
   rota `status.arquive.online/*` apontando para o Worker `arquive-keepalive`.

Não é preciso usar ALIAS/ANAME: a Cloudflare achata o CNAME no apex. Não
aponte `www` para a Vercel; a Vercel está bloqueada por fair use e o Blob é
usado apenas como storage.

## 5. Manter acordado, monitorar e alertar

O Render free dorme após ~15 min. Hoje há duas camadas independentes:

1. **GitHub Actions** (`.github/workflows/keepalive.yml`): a cada 5 min chama
   `/health` no domínio público e, se falhar, tenta `arquive.onrender.com`.
   Em falha, abre/atualiza uma issue com a label `arquive-incident`; quando
   volta, fecha a issue automaticamente.
2. **Cloudflare Worker `arquive-keepalive`**: cron `*/5 * * * *` na borda da
   Cloudflare, também chama `/health`. Serve a página
   <https://status.arquive.online> com checagem ao vivo do domínio e da origem.

O `CRON_SECRET` está configurado como secret no GitHub e no Render; o workflow
 também chama `/api/cron/maintenance` a cada 5 min.

```text
GET https://www.arquive.online/api/cron/maintenance
Header: Authorization: Bearer <CRON_SECRET>
```

Se quiser uma terceira camada, adicione UptimeRobot em
`https://www.arquive.online/health` a cada 5 min. Não é necessário para o
funcionamento atual.

## 6. Checklist de aceite

- [ ] `/` abre com HTTPS e login.
- [ ] Upload de arquivo pequeno e de 2 MB; download byte a byte.
- [ ] Upload de arquivo > 100 MB direto no bucket.
- [ ] Preview com `Range` (vídeo/PDF).
- [ ] Link público `/f/...` abre, baixa e expira conforme configurado.
- [ ] Acervo copia um arquivo da sala e baixa a cópia.
- [ ] Coleta recebe um arquivo e o organizador baixa o ZIP.
- [ ] Notificação push e e-mail (se configurados).
- [ ] Cron responde 200 com o Bearer correto e 401 sem ele.

## Rollback

Se algo falhar, volte os registros DNS para os valores da Vercel. O código da
Vercel continua com `STORAGE_PROVIDER=blob` por padrão e não foi alterado por
este caminho.

## Limitações honestas

- Render free tem 512 MB e dorme; para SLA real, o próximo passo é um plano pago
  ou uma VM (Oracle/Koyeb).
- R2 pode exigir cartão para ativar; B2 é a alternativa sem cartão, com
  1 GB/dia de download grátis.
- Arquivos acima de 5 GiB por objeto precisam de multipart S3 (não implementado
  neste adaptador); o limite atual é 5 GiB por arquivo.
- ZIP de sala/coleta ainda passa pelo Render; downloads individuais vão direto
  ao bucket.
