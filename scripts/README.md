# scripts/ - Operación de producción

Scripts bash para tareas operativas que NO viven en Docker (backups, restore,
mantenimiento puntual). Pensados para ejecutarse en el VPS con el usuario
`deploy` desde `/opt/storageos`.

## Requisitos en el host

```bash
sudo apt install -y postgresql-client gnupg awscli
```

Aunque `pg_dump` se ejecuta DENTRO del contenedor de Postgres, dejamos el
cliente local instalado por comodidad para depuración manual.

## Permisos

Los scripts se distribuyen sin bit de ejecución (la herramienta `Write` de
Claude no lo añade). Ejecuta una vez tras clonar:

```bash
chmod +x /opt/storageos/scripts/*.sh
```

## Variables de entorno

Todos los scripts cargan `/opt/storageos/.env.prod` automáticamente si existe
(`ENV_FILE=/otra/ruta/.env` para sobreescribir). Las variables relevantes
están documentadas en `docs/DEPLOYMENT.md §5.2`.

---

## `backup.sh`

Backup diario cifrado:

1. `pg_dump --format=custom --compress=9` contra el contenedor `postgres`.
2. `gpg --symmetric --cipher-algo AES256` con `BACKUP_GPG_PASSPHRASE`.
3. `aws s3 cp` del dump cifrado a Backblaze B2 (S3-compatible).
4. `mc mirror` de cada bucket MinIO al bucket remoto.
5. Borra backups locales > `BACKUP_RETENTION_DAYS` (default 30).

### Cron sugerido

Como usuario `deploy`:

```bash
crontab -e
```

```cron
# Backup diario a las 3:00 (Europe/Madrid). UTC + 1h o + 2h según DST.
0 3 * * * /opt/storageos/scripts/backup.sh >> /var/log/storageos-backup.log 2>&1
```

Asegúrate de que `/var/log/storageos-backup.log` es writable por `deploy`:

```bash
sudo touch /var/log/storageos-backup.log
sudo chown deploy:deploy /var/log/storageos-backup.log
```

### Probar manualmente

```bash
cd /opt/storageos
./scripts/backup.sh
```

Si todo va bien verás algo como:

```
[2026-05-20T01:00:00Z] ===== Backup TrasterOS - 20260520-010000 =====
[2026-05-20T01:00:00Z] [1/4] pg_dump...
[2026-05-20T01:00:02Z] pg_dump OK (4.2M)
...
[2026-05-20T01:00:10Z] ===== Backup completado OK =====
```

---

## `restore.sh`

Restaura un dump cifrado:

```bash
# Listar backups disponibles en B2
aws --endpoint-url "$B2_ENDPOINT" s3 ls "s3://$B2_BUCKET/postgres/"

# Descargar el que quieras restaurar
aws --endpoint-url "$B2_ENDPOINT" s3 cp \
  "s3://$B2_BUCKET/postgres/postgres-storageos-20260519-030000.dump.gpg" \
  /tmp/

# Restaurar
./scripts/restore.sh /tmp/postgres-storageos-20260519-030000.dump.gpg
```

Pide confirmación interactiva escribiendo el nombre de la BD. Para CI/scripts:

```bash
FORCE=1 ./scripts/restore.sh /tmp/foo.dump.gpg
```

### Procedimiento de disaster recovery

1. Provisionar VPS nuevo según `docs/DEPLOYMENT.md §1-4`.
2. Clonar repo + crear `.env.prod` (mismas claves y passphrase GPG que el original).
3. Levantar solo `postgres redis minio` con `docker compose ... up -d`.
4. Aplicar migraciones (`run --rm migrate`) — restauraremos sobre el schema ya creado.
5. Descargar el último dump de B2 y ejecutar `restore.sh`.
6. Sincronizar de vuelta MinIO desde B2 con `mc mirror`.
7. Levantar `api` + `web`.
8. Verificar con `curl https://api.tu-dominio.com/health` y login.

---

## Notas

- Los scripts NO sustituyen una estrategia de réplica caliente. Para RPO < 24h
  hace falta WAL streaming o `pgBackRest` (pendiente Fase 8D).
- El `BACKUP_GPG_PASSPHRASE` debe vivir en un gestor de secretos (1Password,
  Bitwarden) APARTE del `.env.prod` del VPS: si pierdes el `.env.prod` y la
  passphrase a la vez, los backups son inútiles.
- Backblaze B2 con Object Lock activado en el bucket evita borrados accidentales
  o ataques tipo ransomware.
