import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';

export const prerender = false;


/* =========================================================
   TYPES
   ========================================================= */

interface StripeEvent {
	id: string;
	type: string;
	data: {
		object: {
			id?: string;
			payment_status?: string;
			customer_details?: {
				email?: string;
				name?: string;
				address?: {
					line1?: string;
					line2?: string;
					city?: string;
					postal_code?: string;
					country?: string;
				};
			};
			amount_total?: number;
			currency?: string;
			shipping_details?: {
				name?: string;
				address?: {
					line1?: string;
					line2?: string;
					city?: string;
					postal_code?: string;
					country?: string;
				};
			};
		};
	};
}


/* =========================================================
   RESPONSE HELPER
   ========================================================= */

function json(
	data: unknown,
	status = 200,
): Response {

	return new Response(
		JSON.stringify(data),
		{
			status,
			headers: {
				'Content-Type':
					'application/json',
			},
		},
	);

}


/* =========================================================
   CONSTANT-TIME STRING COMPARISON
   ========================================================= */

function secureCompare(
	a: string,
	b: string,
): boolean {

	if (a.length !== b.length) {
		return false;
	}

	let result = 0;

	for (let i = 0; i < a.length; i++) {

		result |=
			a.charCodeAt(i) ^
			b.charCodeAt(i);

	}

	return result === 0;
}


/* =========================================================
   STRIPE SIGNATURE VERIFICATION
   ========================================================= */

async function verifyStripeSignature(
	payload: string,
	signatureHeader: string,
	secret: string,
): Promise<boolean> {

	const parts =
		signatureHeader.split(',');

	let timestamp = '';
	const signatures: string[] = [];


	for (const part of parts) {

		const [key, value] =
			part.split('=');

		if (key === 't') {
			timestamp = value;
		}

		if (key === 'v1') {
			signatures.push(value);
		}

	}


	if (
		!timestamp ||
		signatures.length === 0
	) {

		return false;

	}


	/*
	 * Reject very old webhook requests.
	 *
	 * Five minutes is Stripe's usual tolerance.
	 */

	const timestampNumber =
		Number(timestamp);

	const currentTime =
		Math.floor(Date.now() / 1000);

	if (
		!Number.isFinite(timestampNumber) ||
		Math.abs(
			currentTime - timestampNumber,
		) > 300
	) {

		return false;

	}


	/*
	 * Stripe signs:
	 *
	 * timestamp + "." + payload
	 */

	const signedPayload =
		`${timestamp}.${payload}`;


	const encoder =
		new TextEncoder();


	const keyData =
		encoder.encode(secret);


	const cryptoKey =
		await crypto.subtle.importKey(
			'raw',
			keyData,
			{
				name: 'HMAC',
				hash: 'SHA-256',
			},
			false,
			['sign'],
		);


	const signature =
		await crypto.subtle.sign(
			'HMAC',
			cryptoKey,
			encoder.encode(
				signedPayload,
			),
		);


	const expectedSignature =
		Array.from(
			new Uint8Array(signature),
		)
			.map(
				(byte) =>
					byte
						.toString(16)
						.padStart(2, '0'),
			)
			.join('');


	/*
	 * At least one v1 signature must match.
	 */

	return signatures.some(
		(receivedSignature) =>
			secureCompare(
				receivedSignature,
				expectedSignature,
			),
	);

}


/* =========================================================
   WEBHOOK ENDPOINT
   ========================================================= */

export const POST: APIRoute = async ({
	request,
}) => {

	try {

		/*
		 * Make sure the webhook secret exists.
		 */

		if (!env.STRIPE_WEBHOOK_SECRET) {

			console.error(
				'STRIPE_WEBHOOK_SECRET is missing.',
			);

			return json(
				{
					error:
						'Stripe webhook is not configured.',
				},
				500,
			);

		}


		/*
		 * Stripe signature header.
		 */

		const signature =
			request.headers.get(
				'stripe-signature',
			);


		if (!signature) {

			console.error(
				'Stripe signature header is missing.',
			);

			return json(
				{
					error:
						'Missing Stripe signature.',
				},
				400,
			);

		}


		/*
		 * IMPORTANT:
		 *
		 * Read the raw body.
		 *
		 * Do NOT call request.json()
		 * before signature verification.
		 */

		const payload =
			await request.text();


		/*
		 * Verify that the request
		 * actually came from Stripe.
		 */

		const valid =
			await verifyStripeSignature(
				payload,
				signature,
				env.STRIPE_WEBHOOK_SECRET,
			);


		if (!valid) {

			console.error(
				'Invalid Stripe webhook signature.',
			);

			return json(
				{
					error:
						'Invalid Stripe signature.',
				},
				400,
			);

		}


		/*
		 * Signature is valid.
		 *
		 * Now it is safe to parse the event.
		 */

		const event =
			JSON.parse(
				payload,
			) as StripeEvent;


		console.log(
			'Stripe webhook received:',
			event.type,
			event.id,
		);


		/*
		 * Handle completed Checkout sessions.
		 */

		if (
			event.type ===
			'checkout.session.completed'
		) {

			const session =
				event.data.object;


			console.log(
				'ORDER COMPLETED',
				{
					sessionId:
						session.id,

					paymentStatus:
						session.payment_status,

					amountTotal:
						session.amount_total,

					currency:
						session.currency,

					customerEmail:
						session
							.customer_details
							?.email,

					customerName:
						session
							.customer_details
							?.name,

					address:
						session
							.shipping_details
							?.address,
				},
			);

		}


		/*
		 * Tell Stripe that the event
		 * was successfully received.
		 */

		return json({
			received: true,
		});


	} catch (error) {

		console.error(
			'Stripe webhook error:',
			error,
		);

		return json(
			{
				error:
					'Webhook processing failed.',
			},
			500,
		);

	}

};
