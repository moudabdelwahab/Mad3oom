<?php
/**
 * Extracts translatable strings (text domain mad3oom-support) into a .pot.
 * Usage: php make-pot.php <plugin-dir> <out.pot>
 * A small stand-in for `wp i18n make-pot` (WP-CLI is not available in CI).
 */
$dir = rtrim($argv[1], '/');
$out = $argv[2];
$funcs = '__|_e|esc_html__|esc_html_e|esc_attr__|esc_attr_e';
$entries = array();
$it = new RecursiveIteratorIterator(new RecursiveDirectoryIterator($dir));
foreach ($it as $file) {
    if ($file->getExtension() !== 'php') continue;
    $src = file_get_contents($file->getPathname());
    $rel = substr($file->getPathname(), strlen($dir) + 1);
    if (preg_match_all("/\\b(?:$funcs)\\(\\s*'((?:[^'\\\\]|\\\\.)*)'\\s*,\\s*'mad3oom-support'\\s*\\)/", $src, $m, PREG_OFFSET_CAPTURE)) {
        foreach ($m[1] as $hit) {
            $line = substr_count(substr($src, 0, $hit[1]), "\n") + 1;
            $msg = stripcslashes($hit[0]);
            $entries[$msg][] = "$rel:$line";
        }
    }
}
ksort($entries);
$esc = function ($s) { return str_replace(array('\\', '"', "\n"), array('\\\\', '\\"', '\\n'), $s); };
$pot = "msgid \"\"\nmsgstr \"\"\n\"Project-Id-Version: Mad3oom Support 0.1.0\\n\"\n\"MIME-Version: 1.0\\n\"\n\"Content-Type: text/plain; charset=UTF-8\\n\"\n\"Content-Transfer-Encoding: 8bit\\n\"\n\"X-Domain: mad3oom-support\\n\"\n\n";
foreach ($entries as $msg => $refs) {
    $pot .= '#: ' . implode(' ', array_unique($refs)) . "\n";
    if (strpos($msg, '%') !== false) $pot .= "#, php-format\n";
    $pot .= 'msgid "' . $esc($msg) . "\"\nmsgstr \"\"\n\n";
}
file_put_contents($out, $pot);
fwrite(STDERR, count($entries) . " strings\n");
