<?php
/**
 * Uninstall: removes every option the plugin stored, including the pairing
 * secret. Disconnect the site in the Mad3oom dashboard as well, which deletes
 * the server-side secret.
 *
 * @package Mad3oom_Support
 */

if ( ! defined( 'WP_UNINSTALL_PLUGIN' ) ) {
	exit;
}

require_once __DIR__ . '/includes/class-mad3oom-settings.php';
Mad3oom_Support_Settings::uninstall();
