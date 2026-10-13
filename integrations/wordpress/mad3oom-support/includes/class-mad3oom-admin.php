<?php
/**
 * Settings > Mad3oom Support.
 *
 * Every action requires manage_options and a nonce. The pairing secret is
 * accepted once and never displayed again (the page only says whether the
 * site is paired). Diagnostics show versions, HTTPS and the last result code.
 *
 * @package Mad3oom_Support
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * Admin page.
 */
class Mad3oom_Support_Admin {

	const PAGE  = 'mad3oom-support';
	const NONCE = 'mad3oom_support_admin';

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
		add_action( 'admin_menu', array( $this, 'menu' ) );
		add_action( 'admin_post_mad3oom_support_admin', array( $this, 'handle' ) );
		add_filter( 'plugin_action_links_' . plugin_basename( MAD3OOM_SUPPORT_FILE ), array( $this, 'action_links' ) );
	}

	/**
	 * Menu entry.
	 */
	public function menu() {
		add_options_page(
			__( 'Mad3oom Support', 'mad3oom-support' ),
			__( 'Mad3oom Support', 'mad3oom-support' ),
			'manage_options',
			self::PAGE,
			array( $this, 'render' )
		);
	}

	/**
	 * Settings link on the Plugins screen.
	 *
	 * @param array $links Links.
	 * @return array
	 */
	public function action_links( $links ) {
		array_unshift( $links, '<a href="' . esc_url( admin_url( 'options-general.php?page=' . self::PAGE ) ) . '">' . esc_html__( 'Settings', 'mad3oom-support' ) . '</a>' );
		return $links;
	}

	/**
	 * Diagnostics (no secrets).
	 *
	 * @return array label => value
	 */
	public function diagnostics() {
		$connection = $this->settings->connection();
		$health     = $this->settings->health();
		$endpoint   = isset( $connection['endpoint'] ) ? wp_parse_url( $connection['endpoint'], PHP_URL_HOST ) : '';
		return array(
			__( 'WordPress version', 'mad3oom-support' )   => get_bloginfo( 'version' ),
			__( 'PHP version', 'mad3oom-support' )         => PHP_VERSION,
			__( 'WooCommerce', 'mad3oom-support' )         => defined( 'WC_VERSION' ) ? WC_VERSION : __( 'not active', 'mad3oom-support' ),
			__( 'Site uses HTTPS', 'mad3oom-support' )     => is_ssl() || 0 === strpos( home_url(), 'https://' ) ? __( 'yes', 'mad3oom-support' ) : __( 'no', 'mad3oom-support' ),
			__( 'Paired', 'mad3oom-support' )              => $this->settings->is_paired() ? __( 'yes', 'mad3oom-support' ) : __( 'no', 'mad3oom-support' ),
			__( 'Mad3oom endpoint host', 'mad3oom-support' ) => $endpoint ? $endpoint : '—',
			__( 'Last check', 'mad3oom-support' )          => empty( $health['at'] ) ? '—'
				: ( $health['ok'] ? __( 'OK', 'mad3oom-support' ) : Mad3oom_Support_Client::message( $health['code'] ) ) . ' (' . wp_date( 'Y-m-d H:i', (int) $health['at'] ) . ')',
		);
	}

	/**
	 * Renders the page.
	 */
	public function render() {
		if ( ! current_user_can( 'manage_options' ) ) {
			wp_die( esc_html__( 'You do not have permission to access this page.', 'mad3oom-support' ) );
		}
		$general = $this->settings->general();
		$paired  = $this->settings->is_paired();
		// phpcs:ignore WordPress.Security.NonceVerification.Recommended -- display only.
		$notice = isset( $_GET['mad3oom_notice'] ) ? sanitize_key( wp_unslash( $_GET['mad3oom_notice'] ) ) : '';
		$notices = array(
			'paired'       => array( 'success', __( 'Paired with Mad3oom. Use "Test connection" to confirm.', 'mad3oom-support' ) ),
			'bad_code'     => array( 'error', __( 'That pairing code is not valid. Copy it again from Mad3oom > Company dashboard > Integrations > WordPress.', 'mad3oom-support' ) ),
			'unpaired'     => array( 'success', __( 'This site was disconnected locally. Also disconnect it in your Mad3oom dashboard.', 'mad3oom-support' ) ),
			'saved'        => array( 'success', __( 'Settings saved.', 'mad3oom-support' ) ),
			'test_ok'      => array( 'success', __( 'Mad3oom answered: the connection works.', 'mad3oom-support' ) ),
			'test_failed'  => array( 'error', Mad3oom_Support_Client::message( (string) ( $this->settings->health()['code'] ?? '' ) ) ),
		);
		?>
		<div class="wrap">
			<h1><?php esc_html_e( 'Mad3oom Support', 'mad3oom-support' ); ?></h1>
			<?php if ( isset( $notices[ $notice ] ) ) : ?>
				<div class="notice notice-<?php echo esc_attr( $notices[ $notice ][0] ); ?>" role="status"><p><?php echo esc_html( $notices[ $notice ][1] ); ?></p></div>
			<?php endif; ?>

			<h2><?php esc_html_e( 'Connection', 'mad3oom-support' ); ?></h2>
			<?php if ( $paired ) : ?>
				<p><?php esc_html_e( 'This site is paired with your Mad3oom company. The pairing secret is stored on this server only and is never shown again.', 'mad3oom-support' ); ?></p>
				<form method="post" action="<?php echo esc_url( admin_url( 'admin-post.php' ) ); ?>" style="display:inline">
					<input type="hidden" name="action" value="mad3oom_support_admin">
					<input type="hidden" name="op" value="test">
					<?php wp_nonce_field( self::NONCE ); ?>
					<?php submit_button( __( 'Test connection', 'mad3oom-support' ), 'secondary', 'submit', false ); ?>
				</form>
				<form method="post" action="<?php echo esc_url( admin_url( 'admin-post.php' ) ); ?>" style="display:inline">
					<input type="hidden" name="action" value="mad3oom_support_admin">
					<input type="hidden" name="op" value="unpair">
					<?php wp_nonce_field( self::NONCE ); ?>
					<?php submit_button( __( 'Disconnect this site', 'mad3oom-support' ), 'delete', 'submit', false ); ?>
				</form>
			<?php else : ?>
				<form method="post" action="<?php echo esc_url( admin_url( 'admin-post.php' ) ); ?>">
					<input type="hidden" name="action" value="mad3oom_support_admin">
					<input type="hidden" name="op" value="pair">
					<?php wp_nonce_field( self::NONCE ); ?>
					<p>
						<label for="mad3oom-pairing"><?php esc_html_e( 'Pairing code', 'mad3oom-support' ); ?></label><br>
						<input id="mad3oom-pairing" name="pairing_code" type="password" class="large-text" autocomplete="off" spellcheck="false" required aria-describedby="mad3oom-pairing-help">
					</p>
					<p id="mad3oom-pairing-help" class="description"><?php esc_html_e( 'In Mad3oom: Company dashboard > Integrations > WordPress > Connect. The code is shown once.', 'mad3oom-support' ); ?></p>
					<?php submit_button( __( 'Pair with Mad3oom', 'mad3oom-support' ) ); ?>
				</form>
			<?php endif; ?>

			<h2><?php esc_html_e( 'Support form and portal', 'mad3oom-support' ); ?></h2>
			<form method="post" action="<?php echo esc_url( admin_url( 'admin-post.php' ) ); ?>">
				<input type="hidden" name="action" value="mad3oom_support_admin">
				<input type="hidden" name="op" value="save">
				<?php wp_nonce_field( self::NONCE ); ?>
				<table class="form-table" role="presentation">
					<tr>
						<th scope="row"><?php esc_html_e( 'Support form', 'mad3oom-support' ); ?></th>
						<td>
							<label><input type="checkbox" name="form_enabled" value="1" <?php checked( $general['form_enabled'] ); ?>>
							<?php esc_html_e( 'Enable the [mad3oom_support_form] shortcode', 'mad3oom-support' ); ?></label>
							<p class="description"><?php esc_html_e( 'Requests arrive in Mad3oom as support requests for your company admin to review. They are not tickets until the admin converts them for an existing customer.', 'mad3oom-support' ); ?></p>
						</td>
					</tr>
					<tr>
						<th scope="row"><label for="mad3oom-support-page"><?php esc_html_e( 'Support page URL', 'mad3oom-support' ); ?></label></th>
						<td><input id="mad3oom-support-page" name="support_page_url" type="url" class="regular-text" value="<?php echo esc_attr( $general['support_page_url'] ); ?>">
							<p class="description"><?php esc_html_e( 'The page that contains the form. Used for the "Request support" action on WooCommerce orders.', 'mad3oom-support' ); ?></p></td>
					</tr>
					<tr>
						<th scope="row"><label for="mad3oom-portal"><?php esc_html_e( 'Customer portal URL', 'mad3oom-support' ); ?></label></th>
						<td><input id="mad3oom-portal" name="portal_url" type="url" class="regular-text" value="<?php echo esc_attr( $general['portal_url'] ); ?>">
							<p class="description"><?php esc_html_e( 'Optional HTTPS link shown by the [mad3oom_portal_link] shortcode.', 'mad3oom-support' ); ?></p></td>
					</tr>
				</table>
				<?php submit_button(); ?>
			</form>

			<h2><?php esc_html_e( 'Diagnostics', 'mad3oom-support' ); ?></h2>
			<table class="widefat striped" role="presentation">
				<tbody>
				<?php foreach ( $this->diagnostics() as $label => $value ) : ?>
					<tr><th scope="row"><?php echo esc_html( $label ); ?></th><td><?php echo esc_html( (string) $value ); ?></td></tr>
				<?php endforeach; ?>
				</tbody>
			</table>
		</div>
		<?php
	}

	/**
	 * Handles admin-post actions.
	 */
	public function handle() {
		if ( ! current_user_can( 'manage_options' ) ) {
			wp_die( esc_html__( 'You do not have permission to do this.', 'mad3oom-support' ), '', array( 'response' => 403 ) );
		}
		check_admin_referer( self::NONCE );
		$op     = isset( $_POST['op'] ) ? sanitize_key( wp_unslash( $_POST['op'] ) ) : '';
		$notice = 'saved';

		if ( 'pair' === $op ) {
			// The code is a secret: it is parsed and stored, never echoed or logged.
			$raw     = isset( $_POST['pairing_code'] ) ? trim( (string) wp_unslash( $_POST['pairing_code'] ) ) : ''; // phpcs:ignore WordPress.Security.ValidatedSanitizedInput.InputNotSanitized -- validated by parse_pairing_code().
			$pairing = Mad3oom_Support_Settings::parse_pairing_code( $raw );
			if ( null === $pairing ) {
				$notice = 'bad_code';
			} else {
				$this->settings->save_pairing( $pairing );
				$notice = 'paired';
			}
		} elseif ( 'unpair' === $op ) {
			$this->settings->clear_pairing();
			$notice = 'unpaired';
		} elseif ( 'test' === $op ) {
			$result = $this->client->request( 'ping' );
			$notice = $result['ok'] ? 'test_ok' : 'test_failed';
		} elseif ( 'save' === $op ) {
			$this->settings->save_general( wp_unslash( $_POST ) );
		}

		$target = add_query_arg( array( 'page' => self::PAGE, 'mad3oom_notice' => $notice ), admin_url( 'options-general.php' ) );
		if ( apply_filters( 'mad3oom_support_do_redirect', true, $target, $notice ) ) {
			wp_safe_redirect( $target );
			exit;
		}
	}
}
