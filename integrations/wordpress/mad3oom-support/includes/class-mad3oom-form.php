<?php
/**
 * Public support form ([mad3oom_support_form]) and portal link ([mad3oom_portal_link]).
 *
 * The form posts to admin-post.php; the server validates, rate-limits and
 * sends a signed request. Mad3oom stores it as a support request (not a
 * ticket) that the company admin reviews. No JavaScript, no keys in the page.
 *
 * @package Mad3oom_Support
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * Support form.
 */
class Mad3oom_Support_Form {

	const ACTION        = 'mad3oom_support_submit';
	const NONCE         = 'mad3oom_support_form';
	const RATE_LIMIT    = 5;
	const RATE_WINDOW   = 600;

	/**
	 * Settings.
	 *
	 * @var Mad3oom_Support_Settings
	 */
	private $settings;

	/**
	 * Client.
	 *
	 * @var Mad3oom_Support_Client
	 */
	private $client;

	/**
	 * Constructor.
	 *
	 * @param Mad3oom_Support_Settings $settings Settings.
	 * @param Mad3oom_Support_Client   $client   Client.
	 */
	public function __construct( Mad3oom_Support_Settings $settings, Mad3oom_Support_Client $client ) {
		$this->settings = $settings;
		$this->client   = $client;
	}

	/**
	 * Hooks.
	 */
	public function register() {
		add_shortcode( 'mad3oom_support_form', array( $this, 'render_shortcode' ) );
		add_shortcode( 'mad3oom_portal_link', array( $this, 'render_portal_link' ) );
		add_action( 'admin_post_' . self::ACTION, array( $this, 'handle_submit' ) );
		add_action( 'admin_post_nopriv_' . self::ACTION, array( $this, 'handle_submit' ) );
	}

	/**
	 * [mad3oom_portal_link label="..."]
	 *
	 * @param array $atts Attributes.
	 * @return string
	 */
	public function render_portal_link( $atts ) {
		$atts = shortcode_atts( array( 'label' => __( 'Open the support portal', 'mad3oom-support' ) ), (array) $atts );
		$url  = $this->settings->general()['portal_url'];
		if ( '' === $url ) {
			return '';
		}
		return '<a class="mad3oom-portal-link" href="' . esc_url( $url ) . '" rel="noopener">' . esc_html( $atts['label'] ) . '</a>';
	}

	/**
	 * Owner-verified WooCommerce order id from the request, or null.
	 *
	 * @param mixed $raw Raw order id.
	 * @return string|null
	 */
	public static function verified_order_ref( $raw ) {
		$id = absint( $raw );
		if ( ! $id || ! is_user_logged_in() || ! function_exists( 'wc_get_order' ) ) {
			return null;
		}
		$order = wc_get_order( $id );
		if ( ! $order || (int) $order->get_customer_id() !== (int) get_current_user_id() ) {
			return null;
		}
		return (string) $order->get_id();
	}

	/**
	 * Opaque, site-specific reference for a logged-in WordPress user. Never
	 * the raw user id: WordPress and Mad3oom ids are not interchangeable.
	 *
	 * @return string|null
	 */
	public static function site_user_ref() {
		if ( ! is_user_logged_in() ) {
			return null;
		}
		return hash_hmac( 'sha256', 'mad3oom-site-user:' . get_current_user_id(), wp_salt( 'auth' ) );
	}

	/**
	 * Renders the form.
	 *
	 * @return string
	 */
	public function render_shortcode() {
		$general = $this->settings->general();
		if ( ! $general['form_enabled'] || ! $this->settings->is_paired() ) {
			return '';
		}

		$name  = '';
		$email = '';
		if ( is_user_logged_in() ) {
			$user  = wp_get_current_user();
			$name  = $user->display_name;
			$email = $user->user_email;
		}
		// phpcs:ignore WordPress.Security.NonceVerification.Recommended -- display only; re-verified on submit.
		$order_ref = isset( $_GET['mad3oom_order'] ) ? self::verified_order_ref( wp_unslash( $_GET['mad3oom_order'] ) ) : null;
		// phpcs:ignore WordPress.Security.NonceVerification.Recommended -- display only.
		$status = isset( $_GET['mad3oom_status'] ) ? sanitize_key( wp_unslash( $_GET['mad3oom_status'] ) ) : '';

		ob_start();
		include MAD3OOM_SUPPORT_DIR . '/templates/form.php';
		return (string) ob_get_clean();
	}

	/**
	 * Rate-limit key for the current client (hashed, never the raw IP).
	 *
	 * @return string
	 */
	private static function rate_key() {
		$ip = isset( $_SERVER['REMOTE_ADDR'] ) ? sanitize_text_field( wp_unslash( $_SERVER['REMOTE_ADDR'] ) ) : 'unknown';
		return 'mad3oom_rl_' . substr( hash_hmac( 'sha256', $ip, wp_salt( 'nonce' ) ), 0, 32 );
	}

	/**
	 * Validates the submitted fields.
	 *
	 * @param array $post Unslashed $_POST.
	 * @return array { ok: bool, fields: array }
	 */
	public static function validate( array $post ) {
		$fields = array(
			'name'    => sanitize_text_field( (string) ( $post['mad3oom_name'] ?? '' ) ),
			'email'   => sanitize_email( (string) ( $post['mad3oom_email'] ?? '' ) ),
			'subject' => sanitize_text_field( (string) ( $post['mad3oom_subject'] ?? '' ) ),
			'message' => sanitize_textarea_field( (string) ( $post['mad3oom_message'] ?? '' ) ),
		);
		$ok = '' !== $fields['name'] && mb_strlen( $fields['name'] ) <= 120
			&& is_email( $fields['email'] ) && strlen( $fields['email'] ) <= 254
			&& '' !== $fields['subject'] && mb_strlen( $fields['subject'] ) <= 200
			&& '' !== $fields['message'] && mb_strlen( $fields['message'] ) <= 5000;
		return array( 'ok' => (bool) $ok, 'fields' => $fields );
	}

	/**
	 * Handles admin-post submission.
	 */
	public function handle_submit() {
		$back = wp_get_referer() ? wp_get_referer() : home_url( '/' );
		$back = remove_query_arg( array( 'mad3oom_status' ), $back );

		if ( ! isset( $_POST['_mad3oom_nonce'] ) || ! wp_verify_nonce( sanitize_text_field( wp_unslash( $_POST['_mad3oom_nonce'] ) ), self::NONCE ) ) {
			$this->redirect( $back, 'expired' );
			return;
		}
		// Honeypot: humans leave it empty. Answer as if accepted.
		if ( ! empty( $_POST['mad3oom_website'] ) ) {
			$this->redirect( $back, 'sent' );
			return;
		}
		if ( ! $this->settings->general()['form_enabled'] || ! $this->settings->is_paired() ) {
			$this->redirect( $back, 'unavailable' );
			return;
		}

		$key   = self::rate_key();
		$count = (int) get_transient( $key );
		if ( $count >= self::RATE_LIMIT ) {
			$this->redirect( $back, 'rate_limited' );
			return;
		}
		set_transient( $key, $count + 1, self::RATE_WINDOW );

		$v = self::validate( wp_unslash( $_POST ) );
		if ( ! $v['ok'] ) {
			$this->redirect( $back, 'invalid' );
			return;
		}

		$payload = $v['fields'];
		$order   = isset( $_POST['mad3oom_order'] ) ? self::verified_order_ref( sanitize_text_field( wp_unslash( $_POST['mad3oom_order'] ) ) ) : null;
		if ( null !== $order ) {
			$payload['order_ref'] = $order;
		}
		$ref = self::site_user_ref();
		if ( null !== $ref ) {
			$payload['site_user_ref'] = $ref;
		}

		$result = $this->client->request( 'intake', $payload );
		$this->redirect( $back, $result['ok'] ? 'sent' : ( 'rate_limited' === $result['code'] ? 'rate_limited' : 'failed' ) );
	}

	/**
	 * Redirects back with a status flag (filterable for tests).
	 *
	 * @param string $url    Target.
	 * @param string $status Status.
	 */
	protected function redirect( $url, $status ) {
		$target = add_query_arg( 'mad3oom_status', $status, $url );
		if ( apply_filters( 'mad3oom_support_do_redirect', true, $target, $status ) ) {
			wp_safe_redirect( $target );
			exit;
		}
	}
}
