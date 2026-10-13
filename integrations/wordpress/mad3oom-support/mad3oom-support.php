<?php
/**
 * Plugin Name:       Mad3oom Support
 * Plugin URI:        https://mad3oom.com/
 * Description:       Connects this site to your company's Mad3oom workspace: a support request form, a link to your Mad3oom customer portal, and (with WooCommerce) a "request support" action on customer orders. All requests to Mad3oom are signed on the server; no key ever reaches the browser.
 * Version:           0.1.0
 * Requires at least: 6.0
 * Requires PHP:      7.4
 * Author:            Mad3oom
 * License:           GPL-2.0-or-later
 * License URI:       https://www.gnu.org/licenses/gpl-2.0.html
 * Text Domain:       mad3oom-support
 * Domain Path:       /languages
 * WC requires at least: 7.0
 *
 * @package Mad3oom_Support
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

define( 'MAD3OOM_SUPPORT_VERSION', '0.1.0' );
define( 'MAD3OOM_SUPPORT_FILE', __FILE__ );
define( 'MAD3OOM_SUPPORT_DIR', __DIR__ );
define( 'MAD3OOM_SUPPORT_MIN_PHP', '7.4' );
define( 'MAD3OOM_SUPPORT_MIN_WP', '6.0' );

require_once MAD3OOM_SUPPORT_DIR . '/includes/class-mad3oom-settings.php';
require_once MAD3OOM_SUPPORT_DIR . '/includes/class-mad3oom-client.php';
require_once MAD3OOM_SUPPORT_DIR . '/includes/class-mad3oom-form.php';
require_once MAD3OOM_SUPPORT_DIR . '/includes/class-mad3oom-woocommerce.php';
require_once MAD3OOM_SUPPORT_DIR . '/includes/class-mad3oom-admin.php';

/**
 * Activation: refuse to activate on unsupported PHP/WordPress versions and
 * create the options with autoload disabled for the secret.
 */
function mad3oom_support_activate() {
	if ( version_compare( PHP_VERSION, MAD3OOM_SUPPORT_MIN_PHP, '<' ) || version_compare( get_bloginfo( 'version' ), MAD3OOM_SUPPORT_MIN_WP, '<' ) ) {
		deactivate_plugins( plugin_basename( MAD3OOM_SUPPORT_FILE ) );
		wp_die(
			esc_html(
				sprintf(
					/* translators: 1: minimum WordPress version, 2: minimum PHP version */
					__( 'Mad3oom Support requires WordPress %1$s and PHP %2$s or newer.', 'mad3oom-support' ),
					MAD3OOM_SUPPORT_MIN_WP,
					MAD3OOM_SUPPORT_MIN_PHP
				)
			)
		);
	}
	Mad3oom_Support_Settings::install();
}
register_activation_hook( __FILE__, 'mad3oom_support_activate' );

/**
 * Bootstraps the plugin once WordPress (and WooCommerce, if present) loaded.
 */
function mad3oom_support_boot() {
	load_plugin_textdomain( 'mad3oom-support', false, dirname( plugin_basename( MAD3OOM_SUPPORT_FILE ) ) . '/languages' );

	$settings = new Mad3oom_Support_Settings();
	$client   = new Mad3oom_Support_Client( $settings );

	( new Mad3oom_Support_Form( $settings, $client ) )->register();
	( new Mad3oom_Support_WooCommerce( $settings ) )->register();

	if ( is_admin() ) {
		( new Mad3oom_Support_Admin( $settings, $client ) )->register();
	}
}
add_action( 'plugins_loaded', 'mad3oom_support_boot' );
