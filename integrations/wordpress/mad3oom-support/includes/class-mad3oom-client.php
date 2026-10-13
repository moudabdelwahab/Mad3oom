<?php
/**
 * Signed requests from this site to Mad3oom (integrations-inbound).
 *
 * Canonical string (must match supabase/functions/_shared/integrations/wordpress.js):
 *   timestamp \n nonce \n METHOD \n path \n sha256_hex(body)
 * Signature: base64( HMAC-SHA256( secret, canonical ) ).
 * Headers:   X-Mad3oom-Connection, X-Mad3oom-Timestamp, X-Mad3oom-Nonce, X-Mad3oom-Signature.
 *
 * Uses the WordPress HTTP API with TLS verification, no redirects, a short
 * timeout and a response size cap. Server messages are never displayed; only
 * fixed error codes are kept.
 *
 * @package Mad3oom_Support
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * HTTP client.
 */
class Mad3oom_Support_Client {

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
	 * Builds the canonical string.
	 *
	 * @param string $timestamp Unix seconds.
	 * @param string $nonce     Random nonce.
	 * @param string $method    HTTP method.
	 * @param string $path      Path after the function name, e.g. /wordpress/v1/ping.
	 * @param string $body      Raw body.
	 * @return string
	 */
	public static function canonical( $timestamp, $nonce, $method, $path, $body ) {
		return $timestamp . "\n" . $nonce . "\n" . strtoupper( $method ) . "\n" . $path . "\n" . hash( 'sha256', $body );
	}

	/**
	 * Computes the request signature.
	 *
	 * @param string $secret    Pairing secret.
	 * @param string $timestamp Unix seconds.
	 * @param string $nonce     Random nonce.
	 * @param string $method    HTTP method.
	 * @param string $path      Path.
	 * @param string $body      Raw body.
	 * @return string
	 */
	public static function sign( $secret, $timestamp, $nonce, $method, $path, $body ) {
		// phpcs:ignore WordPress.PHP.DiscouragedPHPFunctions.obfuscation_base64_encode
		return base64_encode( hash_hmac( 'sha256', self::canonical( $timestamp, $nonce, $method, $path, $body ), $secret, true ) );
	}

	/**
	 * A URL-safe random nonce (22-32 chars).
	 *
	 * @return string
	 */
	public static function nonce() {
		return rtrim( strtr( base64_encode( random_bytes( 24 ) ), '+/', '-_' ), '=' ); // phpcs:ignore WordPress.PHP.DiscouragedPHPFunctions.obfuscation_base64_encode
	}

	/**
	 * Sends a signed request.
	 *
	 * @param string $action ping|intake.
	 * @param array  $payload JSON payload.
	 * @return array { ok: bool, status: int, code: string, data: array }
	 */
	public function request( $action, array $payload = array() ) {
		if ( ! in_array( $action, array( 'ping', 'intake' ), true ) ) {
			return array( 'ok' => false, 'status' => 0, 'code' => 'invalid_input', 'data' => array() );
		}
		if ( ! $this->settings->is_paired() ) {
			return array( 'ok' => false, 'status' => 0, 'code' => 'not_paired', 'data' => array() );
		}
		$connection = $this->settings->connection();
		$endpoint   = Mad3oom_Support_Settings::validate_endpoint( $connection['endpoint'] );
		if ( null === $endpoint ) {
			return array( 'ok' => false, 'status' => 0, 'code' => 'not_paired', 'data' => array() );
		}

		// Mad3oom rejects requests whose site does not match the one registered
		// for this pairing, so a code copied to another site does not work.
		$payload['site'] = home_url( '/' );
		$path            = '/wordpress/v1/' . $action;
		$body            = wp_json_encode( (object) $payload );
		$timestamp = (string) time();
		$nonce     = self::nonce();

		$response = wp_safe_remote_post(
			$endpoint . $path,
			array(
				'timeout'             => 10,
				'redirection'         => 0,
				'sslverify'           => true,
				'limit_response_size' => 65536,
				'headers'             => array(
					'Content-Type'         => 'application/json',
					'Accept'               => 'application/json',
					'X-Mad3oom-Connection' => $connection['connection_id'],
					'X-Mad3oom-Timestamp'  => $timestamp,
					'X-Mad3oom-Nonce'      => $nonce,
					'X-Mad3oom-Signature'  => self::sign( $this->settings->secret(), $timestamp, $nonce, 'POST', $path, $body ),
				),
				'body'                => $body,
			)
		);

		if ( is_wp_error( $response ) ) {
			$result = array( 'ok' => false, 'status' => 0, 'code' => 'network_error', 'data' => array() );
		} else {
			$status = (int) wp_remote_retrieve_response_code( $response );
			$data   = json_decode( (string) wp_remote_retrieve_body( $response ), true );
			$data   = is_array( $data ) ? $data : array();
			$code   = self::code_for_status( $status );
			if ( 403 === $status && 'site_mismatch' === ( $data['error'] ?? '' ) ) {
				$code = 'site_mismatch';
			}
			$result = array( 'ok' => $status >= 200 && $status < 300, 'status' => $status, 'code' => $code, 'data' => $data );
		}

		if ( 'ping' === $action || ! $result['ok'] ) {
			$this->settings->record_health( $result['ok'], $result['code'] );
		}
		return $result;
	}

	/**
	 * Maps an HTTP status to a fixed code.
	 *
	 * @param int $status HTTP status.
	 * @return string
	 */
	public static function code_for_status( $status ) {
		if ( $status >= 200 && $status < 300 ) {
			return '';
		}
		$map = array(
			400 => 'invalid_input',
			401 => 'unauthorized',
			403 => 'connection_inactive',
			404 => 'not_found',
			413 => 'too_large',
			429 => 'rate_limited',
			503 => 'not_configured',
		);
		if ( isset( $map[ $status ] ) ) {
			return $map[ $status ];
		}
		return $status >= 300 && $status < 400 ? 'redirect_refused' : 'server_error';
	}

	/**
	 * Human message for a fixed code.
	 *
	 * @param string $code Code.
	 * @return string
	 */
	public static function message( $code ) {
		switch ( $code ) {
			case 'not_paired':
				return __( 'This site is not connected to Mad3oom yet.', 'mad3oom-support' );
			case 'unauthorized':
				return __( 'Mad3oom rejected the signature. Paste a new pairing code from your Mad3oom dashboard.', 'mad3oom-support' );
			case 'site_mismatch':
				return __( 'This site\'s address does not match the site registered in Mad3oom. Reconnect it with this site\'s exact URL.', 'mad3oom-support' );
			case 'connection_inactive':
				return __( 'The connection is disabled or disconnected in Mad3oom.', 'mad3oom-support' );
			case 'rate_limited':
				return __( 'Too many requests. Please try again later.', 'mad3oom-support' );
			case 'network_error':
				return __( 'Mad3oom could not be reached from this server.', 'mad3oom-support' );
			case 'invalid_input':
				return __( 'Some fields are not valid.', 'mad3oom-support' );
			case 'not_configured':
				return __( 'This integration is not available on Mad3oom yet.', 'mad3oom-support' );
			default:
				return __( 'Something went wrong. Please try again later.', 'mad3oom-support' );
		}
	}
}
