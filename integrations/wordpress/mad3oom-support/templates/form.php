<?php
/**
 * Support form template. Variables: $name, $email, $order_ref, $status.
 *
 * @package Mad3oom_Support
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

$mad3oom_messages = array(
	'sent'         => __( 'Thank you. Your request was sent to our support team.', 'mad3oom-support' ),
	'invalid'      => __( 'Please fill in every field with valid values.', 'mad3oom-support' ),
	'expired'      => __( 'The form expired. Please try again.', 'mad3oom-support' ),
	'rate_limited' => __( 'Too many requests. Please try again later.', 'mad3oom-support' ),
	'unavailable'  => __( 'The support form is not available right now.', 'mad3oom-support' ),
	'failed'       => __( 'We could not send your request. Please try again later.', 'mad3oom-support' ),
);
?>
<form class="mad3oom-support-form" method="post" action="<?php echo esc_url( admin_url( 'admin-post.php' ) ); ?>" novalidate>
	<?php if ( isset( $mad3oom_messages[ $status ] ) ) : ?>
		<p class="mad3oom-support-status mad3oom-support-status--<?php echo esc_attr( $status ); ?>" role="<?php echo 'sent' === $status ? 'status' : 'alert'; ?>">
			<?php echo esc_html( $mad3oom_messages[ $status ] ); ?>
		</p>
	<?php endif; ?>

	<input type="hidden" name="action" value="<?php echo esc_attr( Mad3oom_Support_Form::ACTION ); ?>">
	<?php wp_nonce_field( Mad3oom_Support_Form::NONCE, '_mad3oom_nonce' ); ?>

	<p>
		<label for="mad3oom-name"><?php esc_html_e( 'Your name', 'mad3oom-support' ); ?></label>
		<input id="mad3oom-name" name="mad3oom_name" type="text" maxlength="120" required autocomplete="name" value="<?php echo esc_attr( $name ); ?>">
	</p>
	<p>
		<label for="mad3oom-email"><?php esc_html_e( 'Email', 'mad3oom-support' ); ?></label>
		<input id="mad3oom-email" name="mad3oom_email" type="email" maxlength="254" required autocomplete="email" value="<?php echo esc_attr( $email ); ?>">
	</p>
	<p>
		<label for="mad3oom-subject"><?php esc_html_e( 'Subject', 'mad3oom-support' ); ?></label>
		<input id="mad3oom-subject" name="mad3oom_subject" type="text" maxlength="200" required>
	</p>
	<p>
		<label for="mad3oom-message"><?php esc_html_e( 'How can we help?', 'mad3oom-support' ); ?></label>
		<textarea id="mad3oom-message" name="mad3oom_message" rows="6" maxlength="5000" required></textarea>
	</p>
	<?php if ( null !== $order_ref ) : ?>
		<p class="mad3oom-support-order">
			<?php
			/* translators: %s: order number */
			echo esc_html( sprintf( __( 'About order #%s', 'mad3oom-support' ), $order_ref ) );
			?>
			<input type="hidden" name="mad3oom_order" value="<?php echo esc_attr( $order_ref ); ?>">
		</p>
	<?php endif; ?>
	<p class="mad3oom-support-hp" aria-hidden="true" style="position:absolute;left:-10000px;width:1px;height:1px;overflow:hidden;">
		<label for="mad3oom-website"><?php esc_html_e( 'Leave this field empty', 'mad3oom-support' ); ?></label>
		<input id="mad3oom-website" name="mad3oom_website" type="text" tabindex="-1" autocomplete="off">
	</p>
	<p>
		<button type="submit"><?php esc_html_e( 'Send request', 'mad3oom-support' ); ?></button>
	</p>
</form>
