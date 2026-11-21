# Render Free + S3 — Arquive sem Vercel

Este é o caminho recomendado para tirar o site da Vercel sem alugar uma VM:

```text
Navegador ──► Render Free (Node/Express + Neon) ──► metadados no Postgres
     │
     └──────────────► bucket S3 privado (upload/download direto)
```

O Render serve apenas HTML, APIs e metadados. Os bytes dos arquivos vão do
navegador direto para o bucket e do bucket direto para o navegador. Por isso o
limite de Fast Origin Transfer da Vercel não existe e o plano free do Render
não gasta banda com os arquivos.

## Custos e limites

| Peça | Free tier | Observação |
| --- | --- | --- |
| Render Web Service | 750 h/mês, 512 MB | Dorme após ~15 min sem acesso; primeira visita pode demorar ~1 min |
| Cloudflare R2 | 10 GB, egress US$ 0 | Pode pedir cartão para ativar, mas não cobra dentro do free |
| Backblaze B2 | 10 GB, 1 GB/dia de download | Alternativa se não quiser cartão; mesmo adaptador S3 |
| Neon | plano free atual | Banco já existente; use a URL direta (`DATABASE_URL_UNPOOLED`) |
| Vercel | US$ 0 | Continua como rollback; o Blob antigo é a fonte da migração |

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

## 4. Domínio

No Render, serviço `arquive` → **Settings → Custom Domains**:

1. Adicione `www.arquive.online`.
2. No Hostinger, troque o registro atual da Vercel por:
   - `www` → CNAME para o endereço `*.onrender.com` informado pelo Render;
   - `arquive.online` → ALIAS/ANAME para o Render, ou redirecionamento para
     `https://www.arquive.online` (o Render não emite certificado para um
     domínio que ainda aponta para a Vercel).
3. Espere o certificado TLS do Render ficar **Issued**.
4. Só então remova o domínio da Vercel, se quiser. Manter a Vercel como
   rollback não custa nada enquanto ela estiver bloqueada.

## 5. Manter acordado e cron

O Render free dorme após ~15 min. Para o site não abrir com 1 min de atraso:

- UptimeRobot free: monitor HTTP `https://www.arquive.online/` a cada 5–10 min;
- cron-job.org free: o mesmo monitor, se preferir.

Cron diário de manutenção (4h):

```text
GET https://www.arquive.online/api/cron/maintenance
Header: Authorization: Bearer <CRON_SECRET>
```

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
