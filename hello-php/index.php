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
