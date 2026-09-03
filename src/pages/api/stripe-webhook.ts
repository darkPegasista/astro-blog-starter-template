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
		object: StripeCheckoutSession;
	};
}


interface StripeCheckoutSession {
	id?: string;

	payment_status?: string;

	amount_total?: number;

	currency?: string;

	customer_details?: {
		email?: string | null;
		name?: string | null;

		address?: {
			line1?: string | null;
			line2?: string | null;
			city?: string | null;
			postal_code?: string | null;
			country?: string | null;
		} | null;
	} | null;

	shipping_details?: {
		name?: string | null;

		address?: {
			line1?: string | null;
			line2?: string | null;
			city?: string | null;
			postal_code?: string | null;
			country?: string | null;
		} | null;
	} | null;

	shipping_cost?: {
		amount_total?: number;
	} | null;
}


interface StripeLineItem {
	id?: string;

	quantity?: number;

	price?: {
		unit_amount?: number | null;

		currency?: string;

		product?: string | null;

		product_data?: {
			name?: string;
		};
	} | null;

	description?: string | null;
}


interface StripeLineItemsResponse {
	data?: StripeLineItem[];
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


	const timestampNumber =
		Number(timestamp);

	const currentTime =
		Math.floor(
			Date.now() / 1000,
		);


	/*
	 * Reject webhook requests
	 * older than five minutes.
	 */

	if (
		!Number.isFinite(timestampNumber) ||
		Math.abs(
			currentTime - timestampNumber,
		) > 300
	) {

		return false;

	}


	const signedPayload =
		`${timestamp}.${payload}`;


	const encoder =
		new TextEncoder();


	const cryptoKey =
		await crypto.subtle.importKey(
			'raw',
			encoder.encode(secret),
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


	return signatures.some(
		(receivedSignature) =>
			secureCompare(
				receivedSignature,
				expectedSignature,
			),
	);

}


/* =========================================================
   GET CHECKOUT LINE ITEMS FROM STRIPE
   ========================================================= */

async function getStripeLineItems(
	sessionId: string,
): Promise<StripeLineItem[]> {

	const response =
		await fetch(
			`https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(sessionId)}/line_items`,
			{
				method: 'GET',

				headers: {
					'Authorization':
						`Bearer ${env.STRIPE_SECRET_KEY}`,
				},
			},
		);


	if (!response.ok) {

		const errorText =
			await response.text();

		console.error(
			'Could not retrieve Stripe line items:',
			errorText,
		);

		throw new Error(
			'Could not retrieve Stripe line items.',
		);

	}


	const data =
		await response.json() as StripeLineItemsResponse;


	return data.data ?? [];

}


/* =========================================================
   WEBHOOK
   ========================================================= */

export const POST: APIRoute = async ({
	request,
}) => {

	try {

		/* =====================================================
		   CHECK REQUIRED CLOUDFLARE SECRETS
		   ===================================================== */

		if (!env.STRIPE_SECRET_KEY) {

			console.error(
				'STRIPE_SECRET_KEY is missing.',
			);

			return json(
				{
					error:
						'Stripe secret key is not configured.',
				},
				500,
			);

		}


		if (!env.STRIPE_WEBHOOK_SECRET) {

			console.error(
				'STRIPE_WEBHOOK_SECRET is missing.',
			);

			return json(
				{
					error:
						'Stripe webhook secret is not configured.',
				},
				500,
			);

		}


		/* =====================================================
		   GET STRIPE SIGNATURE
		   ===================================================== */

		const signature =
			request.headers.get(
				'stripe-signature',
			);


		if (!signature) {

			return json(
				{
					error:
						'Missing Stripe signature.',
				},
				400,
			);

		}


		/* =====================================================
		   READ RAW REQUEST BODY
		   ===================================================== */

		const payload =
			await request.text();


		/* =====================================================
		   VERIFY STRIPE SIGNATURE
		   ===================================================== */

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


		/* =====================================================
		   PARSE EVENT
		   ===================================================== */

		const event =
			JSON.parse(
				payload,
			) as StripeEvent;


		console.log(
			'Stripe event received:',
			event.type,
			event.id,
		);


		/* =====================================================
		   ONLY PROCESS COMPLETED CHECKOUTS
		   ===================================================== */

		if (
			event.type !==
			'checkout.session.completed'
		) {

			return json({
				received: true,
			});

		}


		const session =
			event.data.object;


		if (!session.id) {

			throw new Error(
				'Stripe Checkout Session has no ID.',
			);

		}


		/* =====================================================
		   CHECK FOR DUPLICATE EVENT / ORDER
		   ===================================================== */

		const existingOrder =
			await env.DB
				.prepare(
					`
					SELECT id
					FROM orders
					WHERE stripe_session_id = ?
					LIMIT 1
					`,
				)
				.bind(session.id)
				.first();


		if (existingOrder) {

			console.log(
				'Order already exists for session:',
				session.id,
			);

			return json({
				received: true,
				duplicate: true,
			});

		}


		/* =====================================================
		   GET PURCHASED PRODUCTS
		   ===================================================== */

		const stripeItems =
			await getStripeLineItems(
				session.id,
			);


		if (
			stripeItems.length === 0
		) {

			throw new Error(
				'Stripe Checkout Session contains no line items.',
			);

		}


		/* =====================================================
		   BUILD ORDER ITEMS
		   ===================================================== */

		const items = stripeItems.map(
			(item) => ({

				name:
					item.price
						?.product_data
						?.name ??
					item.description ??
					'Unknown product',

				quantity:
					item.quantity ?? 1,

				unit_amount:
					item.price
						?.unit_amount ??
					0,

				currency:
					item.price
						?.currency ??
					session.currency ??
					'eur',

			}),
		);


		/* =====================================================
		   CUSTOMER INFORMATION
		   ===================================================== */

		const customerDetails =
			session.customer_details;


		const shippingDetails =
			session.shipping_details;


		const address =
			shippingDetails?.address ??
			customerDetails?.address;


		const customerName =
			shippingDetails?.name ??
			customerDetails?.name ??
			null;


		const customerEmail =
			customerDetails?.email ??
			null;


		/* =====================================================
		   SHIPPING
		   ===================================================== */

		const shippingAmount =
			session.shipping_cost
				?.amount_total ??
			0;


		/* =====================================================
		   ORDER NUMBER
		   ===================================================== */

		/*
		 * We use a timestamp-based order number for now.
		 *
		 * This avoids duplicate order numbers if two
		 * customers complete checkout at almost exactly
		 * the same time.
		 *
		 * We can later replace this with a clean sequential
		 * LV-0001 system once the basic order database is
		 * fully tested.
		 */

		const orderNumber =
			`LV-${Date.now()}`;


		/* =====================================================
		   SAVE ORDER
		   ===================================================== */

		await env.DB
			.prepare(
				`
				INSERT INTO orders (
					order_number,
					stripe_session_id,
					payment_status,
					customer_name,
					customer_email,
					address_line1,
					address_line2,
					city,
					postal_code,
					country,
					amount_total,
					currency,
					shipping_amount,
					items_json,
					order_status,
					created_at
				)
				VALUES (
					?,
					?,
					?,
					?,
					?,
					?,
					?,
					?,
					?,
					?,
					?,
					?,
					?,
					?,
					?,
					?
				)
				`,
			)
			.bind(

				orderNumber,

				session.id,

				session.payment_status ??
					'paid',

				customerName,

				customerEmail,

				address?.line1 ??
					null,

				address?.line2 ??
					null,

				address?.city ??
					null,

				address?.postal_code ??
					null,

				address?.country ??
					null,

				session.amount_total ??
					0,

				session.currency ??
					'eur',

				shippingAmount,

				JSON.stringify(items),

				'paid',

				new Date().toISOString(),

			)
			.run();


		/* =====================================================
		   LOG SUCCESS
		   ===================================================== */

		console.log(
			'ORDER SAVED',
			{
				orderNumber,
				sessionId: session.id,
				customerEmail,
				amountTotal:
					session.amount_total,
				shippingAmount,
				items,
			},
		);


		/* =====================================================
		   TELL STRIPE WE SUCCESSFULLY PROCESSED THE EVENT
		   ===================================================== */

		return json({
			received: true,
			orderNumber,
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
