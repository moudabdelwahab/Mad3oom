<?php
/**
 * Minimal WordPress function stubs for unit-testing the Mad3oom Support
 * plugin without a WordPress install. They model only what the plugin uses
 * (options with autoload flags, hooks, nonces, transients, HTTP API, escaping).
 * This is NOT WordPress: passing here does not prove behaviour on a live site.
 */

define('ABSPATH', __DIR__ . '/');
define('WP_UNINSTALL_PLUGIN', true);

$GLOBALS['T'] = array();
function t_reset() {
    $GLOBALS['T'] = array(
        'options' => array(), 'autoload' => array(), 'filters' => array(), 'actions' => array(), 'shortcodes' => array(),
        'transients' => array(), 'http' => array(), 'http_reply' => array('response' => array('code' => 200), 'body' => '{"ok":true}'),
        'user_id' => 0, 'user' => null, 'caps' => array(), 'nonce_ok' => true, 'redirects' => array(), 'orders' => array(),
        'wp_version' => '6.6', 'deactivated' => array(),
    );
}
t_reset();

class WP_Error { public $code; public function __construct($c = '', $m = '') { $this->code = $c; } public function get_error_message() { return 'error'; } }
class T_Die extends Exception { public $status; public function __construct($m, $s = 500) { parent::__construct($m); $this->status = $s; } }
class T_Order { private $id; private $cust; public function __construct($id, $cust) { $this->id = $id; $this->cust = $cust; } public function get_id() { return $this->id; } public function get_customer_id() { return $this->cust; } }

function __($s, $d = null) { return $s; }
function esc_html__($s, $d = null) { return esc_html($s); }
function esc_html_e($s, $d = null) { echo esc_html($s); }
function esc_attr_e($s, $d = null) { echo esc_attr($s); }
function esc_html($s) { return htmlspecialchars((string) $s, ENT_QUOTES, 'UTF-8'); }
function esc_attr($s) { return htmlspecialchars((string) $s, ENT_QUOTES, 'UTF-8'); }
function esc_url($u) { $u = (string) $u; return preg_match('#^https?://#', $u) ? htmlspecialchars($u, ENT_QUOTES, 'UTF-8') : ''; }
function esc_url_raw($u, $protocols = null) {
    $u = (string) $u; $s = strtolower((string) parse_url($u, PHP_URL_SCHEME));
    if ($u === '') return '';
    return in_array($s, $protocols ?: array('http', 'https'), true) ? $u : '';
}
function sanitize_text_field($s) { return trim(preg_replace('/[\r\n\t ]+/', ' ', strip_tags((string) $s))); }
function sanitize_textarea_field($s) { return trim(strip_tags((string) $s)); }
function sanitize_email($s) { return preg_replace('/[^a-zA-Z0-9.@_+-]/', '', (string) $s); }
function sanitize_key($s) { return preg_replace('/[^a-z0-9_\-]/', '', strtolower((string) $s)); }
function is_email($e) { return (bool) filter_var($e, FILTER_VALIDATE_EMAIL); }
function absint($v) { return abs((int) $v); }
function wp_unslash($v) { return $v; }
function wp_json_encode($v) { return json_encode($v); }
function wp_parse_url($u, $c = -1) { return $c === -1 ? parse_url($u) : parse_url($u, $c); }
function wp_salt($s = 'auth') { return 'test-salt-' . $s; }

function add_option($k, $v = '', $dep = '', $autoload = 'yes') { if (!array_key_exists($k, $GLOBALS['T']['options'])) { $GLOBALS['T']['options'][$k] = $v; $GLOBALS['T']['autoload'][$k] = $autoload; } return true; }
function update_option($k, $v, $autoload = null) { $GLOBALS['T']['options'][$k] = $v; if ($autoload !== null) $GLOBALS['T']['autoload'][$k] = $autoload; elseif (!isset($GLOBALS['T']['autoload'][$k])) $GLOBALS['T']['autoload'][$k] = 'yes'; return true; }
function get_option($k, $d = false) { return array_key_exists($k, $GLOBALS['T']['options']) ? $GLOBALS['T']['options'][$k] : $d; }
function delete_option($k) { unset($GLOBALS['T']['options'][$k], $GLOBALS['T']['autoload'][$k]); return true; }
function get_transient($k) { return $GLOBALS['T']['transients'][$k] ?? false; }
function set_transient($k, $v, $ttl) { $GLOBALS['T']['transients'][$k] = $v; return true; }

function add_filter($h, $cb, $p = 10, $a = 1) { $GLOBALS['T']['filters'][$h][] = $cb; return true; }
function add_action($h, $cb, $p = 10, $a = 1) { $GLOBALS['T']['actions'][$h][] = $cb; return true; }
function apply_filters($h, $v, ...$args) { foreach ($GLOBALS['T']['filters'][$h] ?? array() as $cb) { $v = $cb($v, ...$args); } return $v; }
function add_shortcode($t, $cb) { $GLOBALS['T']['shortcodes'][$t] = $cb; }
function shortcode_atts($d, $a) { return array_merge($d, array_intersect_key($a, $d)); }
function register_activation_hook($f, $cb) {}
function load_plugin_textdomain() { return true; }
function plugin_basename($f) { return 'mad3oom-support/' . basename($f); }
function deactivate_plugins($p) { $GLOBALS['T']['deactivated'][] = $p; }
function wp_die($m = '', $t = '', $a = array()) { throw new T_Die((string) $m, is_array($a) ? ($a['response'] ?? 500) : 500); }
function get_bloginfo($k) { return $k === 'version' ? $GLOBALS['T']['wp_version'] : ''; }
function is_admin() { return false; }
function is_ssl() { return true; }
function home_url($p = '') { return 'https://site.example' . $p; }
function admin_url($p = '') { return 'https://site.example/wp-admin/' . $p; }
function wp_date($f, $ts) { return gmdate($f, $ts); }
function add_query_arg($k, $v = null, $url = null) {
    if (is_array($k)) { $url = $v; $args = $k; } else { $args = array($k => $v); }
    return $url . (strpos((string) $url, '?') === false ? '?' : '&') . http_build_query($args);
}
function remove_query_arg($k, $url) { return preg_replace('/([?&])mad3oom_status=[^&]*&?/', '$1', $url); }
function wp_get_referer() { return 'https://site.example/support/'; }
function wp_safe_redirect($u) { $GLOBALS['T']['redirects'][] = $u; }

function is_user_logged_in() { return $GLOBALS['T']['user_id'] > 0; }
function get_current_user_id() { return $GLOBALS['T']['user_id']; }
function wp_get_current_user() { return $GLOBALS['T']['user'] ?: (object) array('display_name' => '', 'user_email' => ''); }
function current_user_can($c) { return in_array($c, $GLOBALS['T']['caps'], true); }
function wp_verify_nonce($n, $a) { return $GLOBALS['T']['nonce_ok'] && $n === 'nonce-' . $a ? 1 : false; }
function wp_nonce_field($a, $name = '_wpnonce') { echo '<input type="hidden" name="' . esc_attr($name) . '" value="nonce-' . esc_attr($a) . '">'; }
function check_admin_referer($a) { if (!$GLOBALS['T']['nonce_ok']) throw new T_Die('nonce', 403); return 1; }
function submit_button($t = 'Save', $c = 'primary', $n = 'submit', $wrap = true) { echo '<button type="submit">' . esc_html($t) . '</button>'; }
function checked($v) { echo $v ? ' checked' : ''; }
function add_options_page() {}
function wc_get_order($id) { return $GLOBALS['T']['orders'][$id] ?? false; }

function wp_safe_remote_post($url, $args) { $GLOBALS['T']['http'][] = array('url' => $url, 'args' => $args); return $GLOBALS['T']['http_reply']; }
function is_wp_error($v) { return $v instanceof WP_Error; }
function wp_remote_retrieve_response_code($r) { return $r['response']['code'] ?? 0; }
function wp_remote_retrieve_body($r) { return $r['body'] ?? ''; }
