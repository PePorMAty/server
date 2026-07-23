# Hello World на PHP (Ubuntu + nginx + php-fpm)

Простой сайт-заглушка на PHP для своего VPS с Ubuntu, где уже стоит nginx.
Сайт отдаётся через **nginx + php-fpm** и открывается в браузере по интернету.
Живёт в отдельном каталоге `/var/www/hello` — **никак не связан с Node-сервером** из этого репозитория.

Файлы:
- `index.php` — сама страничка. Показывает версию PHP и время сервера, чтобы было видно, что PHP реально исполняется (а не отдаётся как статичный html).
- `deploy.sh` — скрипт, который на сервере сам всё настраивает: ставит php-fpm, кладёт сайт, пишет конфиг nginx, перезагружает nginx. **Самодостаточный** — `index.php` уже зашит внутри него.

---

## Быстрый способ (рекомендую)

Нужен только `deploy.sh` — больше ничего копировать не надо.

1. Закинь `deploy.sh` на VPS, например с локальной машины:
   ```bash
   scp deploy.sh пользователь@IP_ТВОЕГО_VPS:~/
   ```
   (либо просто создай на сервере файл `deploy.sh` и вставь в него содержимое).

2. На сервере запусти от root:
   ```bash
   sudo bash deploy.sh
   ```

3. Открой в браузере:
   ```
   http://IP_ТВОЕГО_VPS:8080/
   ```

Не открывается? Почти наверняка закрыт порт:
```bash
sudo ufw allow 8080/tcp     # если включён ufw
```
и проверь, что порт `8080` открыт в панели провайдера VPS (firewall / security group).

> Скрипт создаёт **отдельный** конфиг nginx на порту **8080** и **не трогает** твой существующий сайт/ноду.

---

## Что делает скрипт

1. Ставит `php-fpm`, если его ещё нет.
2. Сам определяет сокет php-fpm (`/run/php/phpX.Y-fpm.sock`) — не важно, какая версия PHP на сервере.
3. Создаёт `/var/www/hello` и кладёт туда `index.php` (владелец — `www-data`).
4. Пишет конфиг nginx в `/etc/nginx/sites-available/hello` и включает его симлинком в `sites-enabled`.
5. Проверяет конфиг (`nginx -t`) и перезагружает nginx.

Порт и путь можно поменять в самом верху `deploy.sh` (переменные `PORT`, `SITE_DIR`).

> Если твой nginx не использует каталог `sites-enabled` (бывает при нестандартной установке), положи конфиг в `/etc/nginx/conf.d/hello.conf` вместо симлинка.

---

## Ручной способ (если хочешь понимать по шагам)

```bash
# 1. Поставить php-fpm
sudo apt update && sudo apt install -y php-fpm

# 2. Узнать сокет php-fpm (запомни путь из вывода)
ls /run/php/php*-fpm.sock

# 3. Создать сайт
sudo mkdir -p /var/www/hello
sudo tee /var/www/hello/index.php >/dev/null <<'EOF'
<?php echo "<h1>Hello, World!</h1><p>PHP " . phpversion() . "</p>"; ?>
EOF
sudo chown -R www-data:www-data /var/www/hello
```

Конфиг nginx `/etc/nginx/sites-available/hello` (подставь свой сокет из шага 2):
```nginx
server {
    listen 8080;
    root /var/www/hello;
    index index.php;
    server_name _;

    location / { try_files $uri $uri/ =404; }

    location ~ \.php$ {
        include snippets/fastcgi-php.conf;
        fastcgi_pass unix:/run/php/php8.3-fpm.sock;   # ← свой сокет
    }
}
```
```bash
sudo ln -s /etc/nginx/sites-available/hello /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

---

## Красивый адрес и HTTPS (по желанию)

Порт `:8080` в адресе выглядит некрасиво. Если есть домен:

1. Наведи A-запись домена (или поддомена, например `hello.твойдомен.ру`) на IP твоего VPS.
2. В конфиге поменяй `listen 8080;` → `listen 80;`, а `server_name _;` → `server_name hello.твойдомен.ру;`.
3. Включи HTTPS одной командой:
   ```bash
   sudo apt install -y certbot python3-certbot-nginx
   sudo certbot --nginx -d hello.твойдомен.ру
   ```

Скажи домен — подготовлю готовый конфиг сразу под него (с портом 80 и HTTPS).
