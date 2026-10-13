<?php
/**
 * Behavioural tests for integrations/wordpress/mad3oom-support against the
 * stubs in wp-stubs.php. Run by tests/wordpress-plugin.test.mjs:
 *   php tests/wordpress/plugin-tests.php <valid-pairing-code> <pairing-code-with-evil-endpoint>
 * Prints "PASS <name>" per test, "SIGVECTOR <base64>" for the cross-language
 * check, and exits non-zero on the first failure.
 */
require __DIR__ . '/wp-stubs.php';
$PLUGIN = dirname(__DIR__, 2) . '/integrations/wordpress/mad3oom-support';
require $PLUGIN . '/mad3oom-support.php';

$VALID_CODE = $argv[1] ?? '';
$EVIL_CODE  = $argv[2] ?? '';

function ok($cond, $label) { if (!$cond) { fwrite(STDERR, "FAIL $label\n"); exit(1); } }
function pass($name) { echo "PASS $name\n"; }
function render_admin($admin) { ob_start(); $admin->render(); return ob_get_clean(); }
function no_redirect_exit() { add_filter('mad3oom_support_do_redirect', function ($do, $target = '') { $GLOBALS['T']['redirects'][] = $target; return false; }); }

function paired() {
    global $VALID_CODE;
    $s = new Mad3oom_Support_Settings();
    Mad3oom_Support_Settings::install();
    $p = Mad3oom_Support_Settings::parse_pairing_code($VALID_CODE);
    $s->save_pairing($p);
    return $s;
}

/* 1. Cross-language signature vector (compared with the Edge Function in node) */
$sig = Mad3oom_Support_Client::sign('vector-secret-0123456789abcdef', '1760263200', 'nnnnnnnnnnnnnnnnnnnnnnnn', 'post', '/wordpress/v1/intake', '{"name":"سارة"}');
echo "SIGVECTOR $sig\n";
ok(Mad3oom_Support_Client::canonical('1', 'n', 'post', '/p', '') === "1\nn\nPOST\n/p\n" . hash('sha256', ''), 'canonical format');
pass('signature: canonical string and HMAC-SHA256/base64 as the server expects');

/* 2. Pairing code parsing and endpoint allow-list */
t_reset();
$p = Mad3oom_Support_Settings::parse_pairing_code($VALID_CODE);
ok(is_array($p) && preg_match('/^[0-9a-f-]{36}$/', $p['connection_id']) && strpos($p['endpoint'], 'https://') === 0, 'valid code parses');
ok(Mad3oom_Support_Settings::parse_pairing_code($EVIL_CODE) === null, 'endpoint on a foreign host is refused');
ok(Mad3oom_Support_Settings::parse_pairing_code('m3c1.not-base64!!') === null, 'garbage refused');
ok(Mad3oom_Support_Settings::parse_pairing_code('') === null && Mad3oom_Support_Settings::parse_pairing_code('abc') === null, 'empty refused');
foreach (array('http://proj.supabase.co/functions/v1/x', 'https://supabase.co.evil.com/x', 'https://evil.com/.supabase.co',
               'https://proj.supabase.co:8443/x', 'https://u:p@proj.supabase.co/x', 'https://proj.supabase.co/x?y=1', 'https://.supabase.co/x') as $bad) {
    ok(Mad3oom_Support_Settings::validate_endpoint($bad) === null, "endpoint refused: $bad");
}
ok(Mad3oom_Support_Settings::validate_endpoint('https://proj.supabase.co/functions/v1/integrations-inbound/') === 'https://proj.supabase.co/functions/v1/integrations-inbound', 'endpoint normalised');
pass('pairing: code parsed; endpoint must be https on an allowed Mad3oom host');

/* 3. Activation, autoload, uninstall */
t_reset();
Mad3oom_Support_Settings::install();
ok($GLOBALS['T']['autoload'][Mad3oom_Support_Settings::OPT_SECRET] === 'no', 'secret not autoloaded at install');
$s = paired();
ok($GLOBALS['T']['autoload'][Mad3oom_Support_Settings::OPT_SECRET] === 'no', 'secret not autoloaded after pairing');
ok($s->is_paired(), 'paired');
Mad3oom_Support_Settings::uninstall();
ok(empty($GLOBALS['T']['options']), 'uninstall removes every option');
$GLOBALS['T']['wp_version'] = '5.9';
try { mad3oom_support_activate(); ok(false, 'old WordPress should die'); } catch (T_Die $e) { ok(count($GLOBALS['T']['deactivated']) === 1, 'deactivated on old WordPress'); }
pass('lifecycle: secret never autoloaded; uninstall removes everything; old WordPress refused');

/* 4. Client: no call when unpaired; strict HTTP args; status mapping; health holds codes only */
t_reset();
$s = new Mad3oom_Support_Settings();
$c = new Mad3oom_Support_Client($s);
$r = $c->request('ping');
ok(!$r['ok'] && $r['code'] === 'not_paired' && count($GLOBALS['T']['http']) === 0, 'unpaired: no HTTP');
$s = paired();
$c = new Mad3oom_Support_Client($s);
$r = $c->request('ping');
$call = $GLOBALS['T']['http'][0];
ok($r['ok'], 'ping ok');
ok($call['url'] === 'https://proj.supabase.co/functions/v1/integrations-inbound/wordpress/v1/ping', 'path');
ok($call['args']['redirection'] === 0 && $call['args']['sslverify'] === true && $call['args']['timeout'] === 10 && $call['args']['limit_response_size'] === 65536, 'strict HTTP args');
$h = $call['args']['headers'];
$expected = Mad3oom_Support_Client::sign($s->secret(), $h['X-Mad3oom-Timestamp'], $h['X-Mad3oom-Nonce'], 'POST', '/wordpress/v1/ping', $call['args']['body']);
ok(hash_equals($expected, $h['X-Mad3oom-Signature']), 'signature over the exact body');
ok(preg_match('/^[A-Za-z0-9_-]{16,64}$/', $h['X-Mad3oom-Nonce']) === 1, 'nonce shape matches the server');
ok(strpos(json_encode($call), $s->secret()) === false, 'the secret itself is never sent');
$GLOBALS['T']['http_reply'] = array('response' => array('code' => 401), 'body' => '{"error":"unauthorized","detail":"<script>x</script>"}');
$r = $c->request('ping');
ok(!$r['ok'] && $r['code'] === 'unauthorized' && $s->health()['code'] === 'unauthorized', '401 mapped');
$GLOBALS['T']['http_reply'] = new WP_Error('http_request_failed');
ok($c->request('ping')['code'] === 'network_error', 'network error mapped');
$GLOBALS['T']['http_reply'] = array('response' => array('code' => 302), 'body' => '');
ok($c->request('ping')['code'] === 'redirect_refused', 'redirect mapped');
ok($c->request('delete_everything')['code'] === 'invalid_input', 'unknown action refused');
pass('client: unpaired makes no call; TLS, no redirects, timeout, size cap; signed; fixed codes only');

/* 5. Form rendering: off unless enabled and paired; escaped prefill; no secret in HTML */
t_reset();
no_redirect_exit();
$s = new Mad3oom_Support_Settings();
$form = new Mad3oom_Support_Form($s, new Mad3oom_Support_Client($s));
ok($form->render_shortcode() === '', 'unpaired: no form');
$s = paired();
$form = new Mad3oom_Support_Form($s, new Mad3oom_Support_Client($s));
ok($form->render_shortcode() === '', 'disabled: no form');
$s->save_general(array('form_enabled' => '1', 'portal_url' => 'http://insecure.example', 'support_page_url' => 'https://site.example/support/'));
ok($s->general()['portal_url'] === '', 'portal must be https');
$GLOBALS['T']['user_id'] = 7;
$GLOBALS['T']['user'] = (object) array('display_name' => '"><script>alert(1)</script>', 'user_email' => 'u@example.com');
$html = $form->render_shortcode();
ok(strpos($html, '<script>alert(1)') === false && strpos($html, '&lt;script&gt;') !== false, 'prefill escaped');
ok(strpos($html, 'name="mad3oom_website"') !== false && strpos($html, 'nonce-mad3oom_support_form') !== false, 'honeypot and nonce present');
ok(strpos($html, $s->secret()) === false && strpos($html, 'X-Mad3oom') === false && strpos($html, '<script') === false, 'no secret and no script in the page');
pass('form: hidden unless enabled and paired; escaped; honeypot + nonce; no secret or script in the page');

/* 6. Submission: nonce, honeypot, rate limit, validation, order ownership, opaque user ref */
function submit($post) {
    global $form;
    $GLOBALS['T']['http'] = array();
    $GLOBALS['T']['redirects'] = array();
    $_POST = $post;
    $form->handle_submit();
    return end($GLOBALS['T']['redirects']);
}
$good = array('_mad3oom_nonce' => 'nonce-mad3oom_support_form', 'mad3oom_name' => 'سارة', 'mad3oom_email' => 'sara@example.com',
              'mad3oom_subject' => 'طلبي متأخر', 'mad3oom_message' => 'لم يصل');
$GLOBALS['T']['nonce_ok'] = false;
ok(strpos(submit($good), 'mad3oom_status=expired') !== false && count($GLOBALS['T']['http']) === 0, 'bad nonce: nothing sent');
$GLOBALS['T']['nonce_ok'] = true;
ok(strpos(submit($good + array('mad3oom_website' => 'http://spam')), 'mad3oom_status=sent') !== false && count($GLOBALS['T']['http']) === 0, 'honeypot: nothing sent');
ok(strpos(submit(array_merge($good, array('mad3oom_email' => 'not-an-email'))), 'invalid') !== false && count($GLOBALS['T']['http']) === 0, 'invalid email');

$GLOBALS['T']['orders'][501] = new T_Order(501, 7);   // belongs to user 7
$GLOBALS['T']['orders'][502] = new T_Order(502, 99);  // someone else's
ok(strpos(submit($good + array('mad3oom_order' => '502')), 'sent') !== false, 'sent with foreign order');
$body = json_decode($GLOBALS['T']['http'][0]['args']['body'], true);
ok(!isset($body['order_ref']), 'a foreign order is not attached');
ok(preg_match('/^[0-9a-f]{64}$/', $body['site_user_ref']) === 1 && strpos($GLOBALS['T']['http'][0]['args']['body'], '"7"') === false, 'opaque user ref, not the WP user id');
submit($good + array('mad3oom_order' => '501'));
$body = json_decode($GLOBALS['T']['http'][0]['args']['body'], true);
ok(($body['order_ref'] ?? null) === '501', 'own order attached');
ok(array_keys($body) === array('name', 'email', 'subject', 'message', 'order_ref', 'site_user_ref'), 'only the expected fields are sent');
$GLOBALS['T']['user_id'] = 0;
submit($good + array('mad3oom_order' => '501'));
ok(!isset(json_decode($GLOBALS['T']['http'][0]['args']['body'], true)['order_ref']), 'guests cannot attach orders');
// 4 counted so far (invalid, foreign, own, guest): the 5th is allowed, the 6th is refused
ok(strpos(submit($good), 'sent') !== false && count($GLOBALS['T']['http']) === 1, '5th request in the window allowed');
ok(strpos(submit($good), 'rate_limited') !== false && count($GLOBALS['T']['http']) === 0, '6th request refused (5 per window)');
pass('submit: nonce, honeypot, validation, 5/10min limit; orders attached only for their owner; opaque user ref');

/* 7. WooCommerce "Request support" action */
t_reset();
$s = paired();
$woo = new Mad3oom_Support_WooCommerce($s);
ok($woo->order_action(array(), new T_Order(5, 1)) === array(), 'off while the form is disabled');
$s->save_general(array('form_enabled' => '1', 'support_page_url' => 'https://site.example/support/'));
$a = $woo->order_action(array(), new T_Order(5, 1));
ok(isset($a['mad3oom_support']) && strpos($a['mad3oom_support']['url'], 'mad3oom_order=5') !== false, 'action added with the order id');
pass('woocommerce: "Request support" appears only when enabled, paired and a support page is set');

/* 8. Admin: capability + nonce; pairing secret never echoed */
t_reset();
no_redirect_exit();
$s = new Mad3oom_Support_Settings();
Mad3oom_Support_Settings::install();
$admin = new Mad3oom_Support_Admin($s, new Mad3oom_Support_Client($s));
try { $_POST = array('op' => 'pair', 'pairing_code' => $VALID_CODE); $admin->handle(); ok(false, 'no capability should die'); }
catch (T_Die $e) { ok($e->status === 403 && !$s->is_paired(), 'no capability: refused, nothing stored'); }
$GLOBALS['T']['caps'] = array('manage_options');
$GLOBALS['T']['nonce_ok'] = false;
try { $admin->handle(); ok(false, 'bad nonce should die'); } catch (T_Die $e) { ok(!$s->is_paired(), 'bad nonce: nothing stored'); }
$GLOBALS['T']['nonce_ok'] = true;
$_POST = array('op' => 'pair', 'pairing_code' => $EVIL_CODE);
$admin->handle();
ok(!$s->is_paired(), 'evil endpoint code refused');
$_POST = array('op' => 'pair', 'pairing_code' => $VALID_CODE);
$admin->handle();
ok($s->is_paired(), 'paired via admin');
$html = render_admin($admin);
ok(strpos($html, $s->secret()) === false && strpos($html, $VALID_CODE) === false, 'secret and code never rendered');
ok(strpos($html, 'Test connection') !== false && strpos($html, '.supabase.co') !== false, 'diagnostics show the endpoint host');
$_POST = array('op' => 'unpair');
$admin->handle();
ok(!$s->is_paired() && $s->secret() === '', 'unpair forgets the secret');
pass('admin: manage_options + nonce required; pairing code validated; secret never rendered; unpair forgets it');

echo "ALL WORDPRESS PLUGIN TESTS PASSED\n";
