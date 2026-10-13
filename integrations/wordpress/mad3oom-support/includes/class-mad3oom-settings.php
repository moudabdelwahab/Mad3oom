<?php
/**
 * Settings storage for Mad3oom Support.
 *
 * The pairing secret is stored in its own option with autoload disabled, is
 * never printed back to any page, and is only read by the server-side client
 * that signs requests to Mad3oom.
 *
 * @package Mad3oom_Support
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * Plugin settings.
 */
class Mad3oom_Support_Settings {

	const OPT_CONNECTION = 'mad3oom_support_connection';
	const OPT_SECRET     = 'mad3oom_support_secret';
	const OPT_GENERAL    = 'mad3oom_support_general';
	const OPT_HEALTH     = 'mad3oom_support_health';

	const PAIRING_PREFIX = 'm3c1.';

	/**
	 * Hosts the plugin may send signed requests to. Filterable for staging.
	 *
	 * @return string[]
	 */
	public static function allowed_endpoint_hosts() {
		$hosts = array( '.supabase.co', 'mad3oom.com', 'api.mad3oom.com', 'mad3oom.online' );
		return (array) apply_filters( 'mad3oom_support_allowed_endpoint_hosts', $hosts );
	}

	/**
	 * Creates the options. The secret option is never autoloaded.
	 */
	public static function install() {
		add_option( self::OPT_CONNECTION, array(), '', 'no' );
		add_option( self::OPT_SECRET, '', '', 'no' );
		add_option( self::OPT_GENERAL, self::default_general(), '', 'yes' );
		add_option( self::OPT_HEALTH, array(), '', 'no' );
	}

	/**
	 * Removes every option the plugin created.
	 */
	public static function uninstall() {
		foreach ( array( self::OPT_CONNECTION, self::OPT_SECRET, self::OPT_GENERAL, self::OPT_HEALTH ) as $opt ) {
			delete_option( $opt );
		}
	}

	/**
	 * Default non-secret settings.
	 *
	 * @return array
	 */
	public static function default_general() {
		return array(
			'form_enabled'     => false,
			'portal_url'       => '',
			'support_page_url' => '',
		);
	}

	/**
	 * Validates an endpoint URL against the allowed hosts. Returns the
	 * normalised URL (https, no query, no trailing slash) or null.
	 *
	 * @param string $url Candidate endpoint.
	 * @return string|null
	 */
	public static function validate_endpoint( $url ) {
		$parts = wp_parse_url( (string) $url );
		if ( ! is_array( $parts ) || ( $parts['scheme'] ?? '' ) !== 'https' || empty( $parts['host'] )
			|| isset( $parts['user'] ) || isset( $parts['pass'] ) || isset( $parts['query'] ) || isset( $parts['fragment'] )
			|| ( isset( $parts['port'] ) && 443 !== (int) $parts['port'] ) ) {
			return null;
		}
		$host    = strtolower( $parts['host'] );
		$allowed = false;
		foreach ( self::allowed_endpoint_hosts() as $suffix ) {
			$suffix = strtolower( (string) $suffix );
			if ( '' === $suffix ) {
				continue;
			}
			if ( '.' === $suffix[0] ? ( substr( $host, -strlen( $suffix ) ) === $suffix && strlen( $host ) > strlen( $suffix ) ) : $host === $suffix ) {
				$allowed = true;
				break;
			}
		}
		if ( ! $allowed ) {
			return null;
		}
		$path = isset( $parts['path'] ) ? rtrim( $parts['path'], '/' ) : '';
		if ( '' !== $path && ! preg_match( '#^/[A-Za-z0-9/_-]{1,200}$#', $path ) ) {
			return null;
		}
		return 'https://' . $host . $path;
	}

	/**
	 * Parses a pairing code produced by the Mad3oom dashboard.
	 *
	 * @param string $code m3c1.<base64url(JSON {v, c, s, e})>.
	 * @return array|null { connection_id, secret, endpoint } or null.
	 */
	public static function parse_pairing_code( $code ) {
		$code = trim( (string) $code );
		if ( 0 !== strpos( $code, self::PAIRING_PREFIX ) || strlen( $code ) > 2000 ) {
			return null;
		}
		$b64  = strtr( substr( $code, strlen( self::PAIRING_PREFIX ) ), '-_', '+/' );
		$b64 .= str_repeat( '=', ( 4 - strlen( $b64 ) % 4 ) % 4 );
		$json = base64_decode( $b64, true ); // phpcs:ignore WordPress.PHP.DiscouragedPHPFunctions.obfuscation_base64_decode
		if ( false === $json ) {
			return null;
		}
		$data = json_decode( $json, true );
		if ( ! is_array( $data ) || 1 !== ( $data['v'] ?? null )
			|| ! is_string( $data['c'] ?? null ) || ! preg_match( '/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i', $data['c'] )
			|| ! is_string( $data['s'] ?? null ) || ! preg_match( '/^[A-Za-z0-9_-]{32,128}$/', $data['s'] ) ) {
			return null;
		}
		$endpoint = self::validate_endpoint( $data['e'] ?? '' );
		if ( null === $endpoint ) {
			return null;
		}
		return array(
			'connection_id' => strtolower( $data['c'] ),
			'secret'        => $data['s'],
			'endpoint'      => $endpoint,
		);
	}

	/**
	 * Stores a parsed pairing.
	 *
	 * @param array $pairing Result of parse_pairing_code().
	 */
	public function save_pairing( array $pairing ) {
		update_option(
			self::OPT_CONNECTION,
			array(
				'connection_id' => $pairing['connection_id'],
				'endpoint'      => $pairing['endpoint'],
				'paired_at'     => time(),
			),
			'no'
		);
		update_option( self::OPT_SECRET, $pairing['secret'], 'no' );
		delete_option( self::OPT_HEALTH );
	}

	/**
	 * Forgets the local pairing (the secret is deleted).
	 */
	public function clear_pairing() {
		update_option( self::OPT_CONNECTION, array(), 'no' );
		update_option( self::OPT_SECRET, '', 'no' );
		delete_option( self::OPT_HEALTH );
	}

	/**
	 * Public connection data (no secret).
	 *
	 * @return array
	 */
	public function connection() {
		$c = get_option( self::OPT_CONNECTION, array() );
		return is_array( $c ) ? $c : array();
	}

	/**
	 * The pairing secret, for the signing client only.
	 *
	 * @return string
	 */
	public function secret() {
		return (string) get_option( self::OPT_SECRET, '' );
	}

	/**
	 * Whether the site is paired.
	 *
	 * @return bool
	 */
	public function is_paired() {
		$c = $this->connection();
		return ! empty( $c['connection_id'] ) && ! empty( $c['endpoint'] ) && '' !== $this->secret();
	}

	/**
	 * Non-secret settings.
	 *
	 * @return array
	 */
	public function general() {
		$g = get_option( self::OPT_GENERAL, array() );
		return array_merge( self::default_general(), is_array( $g ) ? $g : array() );
	}

	/**
	 * Sanitises and stores the non-secret settings.
	 *
	 * @param array $input Raw input.
	 * @return array Stored values.
	 */
	public function save_general( array $input ) {
		$portal  = esc_url_raw( trim( (string) ( $input['portal_url'] ?? '' ) ), array( 'https' ) );
		$support = esc_url_raw( trim( (string) ( $input['support_page_url'] ?? '' ) ), array( 'https', 'http' ) );
		$values  = array(
			'form_enabled'     => ! empty( $input['form_enabled'] ),
			'portal_url'       => 0 === strpos( $portal, 'https://' ) ? $portal : '',
			'support_page_url' => $support,
		);
		update_option( self::OPT_GENERAL, $values );
		return $values;
	}

	/**
	 * Records the outcome of the last request (code only, never a message
	 * from the server).
	 *
	 * @param bool   $ok   Whether it succeeded.
	 * @param string $code Fixed error code.
	 */
	public function record_health( $ok, $code = '' ) {
		update_option(
			self::OPT_HEALTH,
			array(
				'ok'   => (bool) $ok,
				'code' => preg_match( '/^[a-z_]{1,48}$/', (string) $code ) ? $code : ( $ok ? '' : 'unknown_error' ),
				'at'   => time(),
			),
			'no'
		);
	}

	/**
	 * Last recorded health.
	 *
	 * @return array
	 */
	public function health() {
		$h = get_option( self::OPT_HEALTH, array() );
		return is_array( $h ) ? $h : array();
	}
}
