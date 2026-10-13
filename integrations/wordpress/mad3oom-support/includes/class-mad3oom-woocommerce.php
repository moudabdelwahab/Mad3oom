<?php
/**
 * WooCommerce touch points.
 *
 * Adds a "Request support" action to each order in My Account > Orders that
 * opens the configured support page with the order id. The id is re-verified
 * on the server when the form is shown and again when it is submitted: it is
 * attached only if the order belongs to the logged-in customer.
 *
 * Order data itself reaches Mad3oom through the separate WooCommerce REST
 * connection (read-only keys created by the merchant), never through this plugin.
 *
 * @package Mad3oom_Support
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * WooCommerce integration.
 */
class Mad3oom_Support_WooCommerce {

	/**
	 * Settings.
	 *
	 * @var Mad3oom_Support_Settings
	 */
	private $settings;

	/**
	 * Constructor.
	 *
	 * @param Mad3oom_Support_Settings $settings Settings.
	 */
	public function __construct( Mad3oom_Support_Settings $settings ) {
		$this->settings = $settings;
	}

	/**
	 * Hooks (only when WooCommerce is active).
	 */
	public function register() {
		if ( ! class_exists( 'WooCommerce' ) ) {
			return;
		}
		add_filter( 'woocommerce_my_account_my_orders_actions', array( $this, 'order_action' ), 10, 2 );
	}

	/**
	 * Adds the "Request support" action.
	 *
	 * @param array    $actions Existing actions.
	 * @param WC_Order $order   Order.
	 * @return array
	 */
	public function order_action( $actions, $order ) {
		$general = $this->settings->general();
		if ( ! $general['form_enabled'] || '' === $general['support_page_url'] || ! $this->settings->is_paired() || ! is_object( $order ) ) {
			return $actions;
		}
		$actions['mad3oom_support'] = array(
			'url'  => add_query_arg( 'mad3oom_order', absint( $order->get_id() ), $general['support_page_url'] ),
			'name' => __( 'Request support', 'mad3oom-support' ),
		);
		return $actions;
	}
}
