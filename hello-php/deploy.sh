#!/usr/bin/env bash
#
# Разворачивает простой PHP "Hello World" сайт на Ubuntu с nginx + php-fpm.
# Запускать НА VPS от root:   sudo bash deploy.sh
#
# Скрипт самодостаточный: index.php зашит внутри, ничего больше копировать не нужно.
# Он НЕ трогает существующие сайты/конфиги — добавляет отдельный сайт на своём порту.
#
set -euo pipefail

# ===== Настройки (при желании поменяй) =====
SITE_DIR="/var/www/hello"     # где будут лежать файлы сайта
PORT="8080"                   # порт, на котором открывается сайт
NGINX_SITE="hello"            # имя конфига nginx
# ===========================================

if [ "$(id -u)" -ne 0 ]; then
  echo "Запускай от root:  sudo bash deploy.sh" >&2
  exit 1
fi

echo "==> Проверяю php-fpm..."
if ! ls /run/php/php*-fpm.sock >/dev/null 2>&1; then
  echo "    php-fpm не найден — ставлю..."
  apt-get update -y
  apt-get install -y php-fpm
fi

FPM_SOCK="$(ls /run/php/php*-fpm.sock 2>/dev/null | head -n1 || true)"
if [ -z "$FPM_SOCK" ]; then
  echo "Не удалось найти сокет php-fpm в /run/php/. Проверь установку php-fpm." >&2
  exit 1
fi
echo "==> php-fpm сокет: $FPM_SOCK"

echo "==> Создаю каталог сайта: $SITE_DIR"
mkdir -p "$SITE_DIR"

echo "==> Пишу index.php"
cat > "$SITE_DIR/index.php" <<'PHPEOF'
<?php
$now = date('Y-m-d H:i:s');
$phpVersion = phpversion();
?>
<!DOCTYPE html>
<html lang="ru">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Hello World</title>
    <style>
        body { font-family: system-ui, sans-serif; display: grid; place-items: center;
               min-height: 100vh; margin: 0; background: #0d1117; color: #e6edf3; }
        .card { text-align: center; padding: 2rem 3rem; background: #161b22;
                border: 1px solid #30363d; border-radius: 12px; }
        h1 { margin: 0 0 .5rem; font-size: 2.5rem; }
        p { margin: .25rem 0; color: #8b949e; }
        code { color: #58a6ff; }
    </style>
</head>
<body>
    <div class="card">
        <h1>Hello, World! &#128075;</h1>
        <p>&#1056;&#1072;&#1073;&#1086;&#1090;&#1072;&#1077;&#1090; &#1085;&#1072; PHP <code><?= htmlspecialchars($phpVersion) ?></code></p>
        <p>&#1042;&#1088;&#1077;&#1084;&#1103; &#1089;&#1077;&#1088;&#1074;&#1077;&#1088;&#1072;: <code><?= htmlspecialchars($now) ?></code></p>
    </div>
</body>
</html>
PHPEOF

chown -R www-data:www-data "$SITE_DIR"

echo "==> Пишу конфиг nginx: /etc/nginx/sites-available/$NGINX_SITE"
cat > "/etc/nginx/sites-available/$NGINX_SITE" <<EOF
server {
    listen $PORT;
    listen [::]:$PORT;

    root $SITE_DIR;
    index index.php index.html;

    server_name _;

    location / {
        try_files \$uri \$uri/ =404;
    }

    location ~ \.php\$ {
        # Параметры FastCGI прописаны напрямую, чтобы работало и на nginx из
        # репозитория Ubuntu, и на сборке с nginx.org (там нет snippets/fastcgi-php.conf).
        fastcgi_split_path_info ^(.+\.php)(/.+)\$;
        fastcgi_pass unix:$FPM_SOCK;
        fastcgi_index index.php;
        include fastcgi_params;
        fastcgi_param SCRIPT_FILENAME \$document_root\$fastcgi_script_name;
        fastcgi_param PATH_INFO \$fastcgi_path_info;
    }

    location ~ /\.ht {
        deny all;
    }
}
EOF

ln -sf "/etc/nginx/sites-available/$NGINX_SITE" "/etc/nginx/sites-enabled/$NGINX_SITE"

echo "==> Проверяю конфиг nginx (nginx -t)..."
nginx -t

echo "==> Перезагружаю nginx..."
systemctl reload nginx

IP="$(hostname -I 2>/dev/null | awk '{print $1}' || true)"
echo ""
echo "✅ Готово!"
echo "   Открой в браузере:  http://${IP:-<IP_твоего_VPS>}:$PORT/"
echo ""
echo "   Если не открывается — почти наверняка закрыт порт. Проверь:"
echo "     sudo ufw allow $PORT/tcp        # если включён ufw"
echo "   и открой порт $PORT в фаерволе/security group у провайдера VPS."
