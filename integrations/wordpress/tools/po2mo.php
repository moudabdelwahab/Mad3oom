<?php
/**
 * Compiles a .po file to a GNU .mo file (little-endian, no hash table).
 * Usage: php po2mo.php in.po out.mo — a stand-in for msgfmt.
 */
$po = file_get_contents($argv[1]);
$entries = array();
$unq = function ($s) { return stripcslashes($s); };
foreach (preg_split("/\n\s*\n/", $po) as $block) {
    if (!preg_match('/^msgid\s+((?:"(?:[^"\\\\]|\\\\.)*"\s*)+)/m', $block, $id)) continue;
    if (!preg_match('/^msgstr\s+((?:"(?:[^"\\\\]|\\\\.)*"\s*)+)/m', $block, $str)) continue;
    $join = function ($raw) use ($unq) {
        preg_match_all('/"((?:[^"\\\\]|\\\\.)*)"/', $raw, $p);
        return $unq(implode('', $p[1]));
    };
    $k = $join($id[1]);
    $v = $join($str[1]);
    if ($v === '' ) continue;
    $entries[$k] = $v;
}
ksort($entries, SORT_STRING);
$n = count($entries);
$keys = array_keys($entries);
$origTableOffset = 28;
$transTableOffset = $origTableOffset + 8 * $n;
$dataOffset = $transTableOffset + 8 * $n;
$orig = ''; $trans = ''; $origData = ''; $transData = '';
$pos = $dataOffset;
foreach ($keys as $k) { $orig .= pack('VV', strlen($k), $pos); $origData .= $k . "\0"; $pos += strlen($k) + 1; }
foreach ($keys as $k) { $v = $entries[$k]; $trans .= pack('VV', strlen($v), $pos); $transData .= $v . "\0"; $pos += strlen($v) + 1; }
$mo = pack('VVVVVVV', 0x950412de, 0, $n, $origTableOffset, $transTableOffset, 0, $dataOffset) . $orig . $trans . $origData . $transData;
file_put_contents($argv[2], $mo);
fwrite(STDERR, "$n messages\n");
