# Oracle Cloud Always Free — instalação do Arquive

Esta instalação mantém o app Node/Express e os arquivos no disco da VM.
O banco continua no Postgres atual (Neon/Supabase) ou em um Postgres local, se preferir.

## 1. Criar a VM

No Oracle Cloud, crie uma instância **Always Free**:

- Ubuntu 22.04 ou 24.04;
- forma Ampere A1 (até 4 OCPU / 24 GB) ou a AMD micro;
- 200 GB de block storage;
- adicione sua chave SSH;
- anote o IP público.

Na lista de segurança da VCN, libere:

- TCP 80 e 443 para `0.0.0.0/0`;
- TCP 22 apenas para o seu IP.

Se a capacidade Ampere estiver esgotada, tente outra região/domínio de disponibilidade ou use a AMD micro (mais lenta).

Dentro da VM, libere também o firewall local:

```bash
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw enable
```

## 2. Instalar Docker

```bash
sudo apt update && sudo apt upgrade -y
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker "$USER"
newgrp docker
```

## 3. Baixar o projeto

```bash
sudo mkdir -p /opt/arquive
sudo chown "$USER":"$USER" /opt/arquive
git clone https://github.com/yago-hkcr/file-share-app.git /opt/arquive
cd /opt/arquive
```

## 4. Configurar

```bash
cp deploy/oracle.env.example .env
nano .env
mkdir -p storage
sudo chown -R 1000:1000 storage  # UID do usuário node dentro do container
```

Preencha o `.env`. O `docker-compose.yml` já define:

- `IS_HOSTED=1` (cookies seguros, HSTS, URL pública);
- `STORAGE_PROVIDER=local`;
- `LOCAL_STORAGE_DIR=/app/storage`.

Sobre o banco:

- use `DATABASE_URL_UNPOOLED` se `DATABASE_URL` vier como `[SENSITIVE]`;
- no Neon, `SUPABASE_CA_CERT_B64` pode ficar vazio (TLS validado pela raiz pública);
- no Supabase, copie o certificado raiz do painel para `SUPABASE_CA_CERT_B64`;
- `vercel env pull` não exporta valores marcados como secretos: copie esses pelo dashboard da Vercel.

## 5. Subir

```bash
docker compose up -d --build
docker compose logs -f app
```

Teste localmente antes do DNS:

```bash
curl -I http://127.0.0.1:3000/
```

## 6. Migrar os arquivos do Vercel Blob

Com o token antigo ainda no `.env`:

```bash
docker compose run --rm app node scripts/migrate-blob-to-local.mjs --dry-run
docker compose run --rm app node scripts/migrate-blob-to-local.mjs
```

O script é idempotente. Depois da migração, remova `BLOB_READ_WRITE_TOKEN` do `.env` e recrie o app:

```bash
docker compose up -d --force-recreate app
```

## 7. Apontar o domínio

No registrador/Hostinger, crie:

- `www.arquive.online` → A para o IP público da VM;
- `arquive.online` → A para o mesmo IP (o Caddy redireciona para `www`).

O Caddy busca o certificado Let's Encrypt automaticamente. Aguarde a propagação e confira:

```bash
curl -I https://www.arquive.online/
```

## 8. Cron de manutenção

O app expõe `/api/cron/maintenance` com `Authorization: Bearer <CRON_SECRET>`.
Crie um cron no host:

```bash
sudo tee /etc/cron.d/arquive-maintenance >/dev/null <<'CRON'
0 4 * * * root curl -fsS -H "Authorization: Bearer SEU_CRON_SECRET" https://www.arquive.online/api/cron/maintenance >/dev/null
CRON
sudo chmod 644 /etc/cron.d/arquive-maintenance
```

## 9. Backup

O que precisa de backup:

- `./storage` (arquivos enviados);
- banco Postgres/Neon/Supabase.

Exemplo de backup local dos arquivos:

```bash
sudo mkdir -p /var/backups
sudo tar -C /opt/arquive -czf /var/backups/arquive-storage-$(date +%F).tgz storage
```

Guarde também um dump do banco (`pg_dump`) fora da VM. O free tier da Oracle não é um serviço de backup.

## 10. Atualizações

```bash
cd /opt/arquive
git pull --ff-only
docker compose up -d --build
```

## Limites e cuidados

- A VM é um ponto único de falha. Se ela cair, o site cai junto.
- O Always Free exige cartão para verificação, mas não cobra dentro dos limites.
- A capacidade ARM pode variar; a Oracle pode recuperar instâncias ociosas.
- O disco de 200 GB é compartilhado entre sistema, imagens Docker, banco local (se usar) e arquivos.
- Se o volume de arquivos passar de 200 GB, migre os bytes para um object storage (R2/MinIO/S3).
- O Neon/Supabase Free tem limite de banco; acompanhe o uso no painel.
