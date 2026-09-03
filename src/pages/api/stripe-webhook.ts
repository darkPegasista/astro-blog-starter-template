import type { APIRoute } from 'astro';

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

	metadata?: {
		[key: string]: string | undefined;
	};
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


interface ReservationItem {
	slug: string;
	quantity: number;
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
   GET CHECKOUT LINE ITEMS
   ========================================================= */

async function getStripeLineItems(
	sessionId: string,
	env: any,
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
   GET NEXT ORDER NUMBER
   ========================================================= */

async function getNextOrderNumber(
	db: any,
): Promise<string> {

	const result =
		await db
			.prepare(
				`
				UPDATE order_counter
				SET next_number = next_number + 1
				WHERE id = 1
				RETURNING next_number - 1 AS assigned_number
				`,
			)
			.first();


	if (
		!result ||
		typeof result.assigned_number !== 'number'
	) {

		throw new Error(
			'Could not generate order number.',
		);

	}


	return `LV-${String(
		result.assigned_number,
	).padStart(4, '0')}`;

}


/* =========================================================
   RELEASE RESERVATION
   ========================================================= */

async function releaseReservation(
	db: any,
	sessionId: string,
): Promise<boolean> {

	/*
	 * Find the reservation.
	 */

	const reservation =
		await db
			.prepare(
				`
				SELECT
					id,
					items_json,
					status
				FROM reservations
				WHERE stripe_session_id = ?
				LIMIT 1
				`,
			)
			.bind(sessionId)
			.first();


	if (!reservation) {

		console.log(
			'No reservation found for expired session:',
			sessionId,
		);

		return false;

	}


	/*
	 * If it has already been released,
	 * do nothing.
	 */

	if (
		reservation.status ===
		'released'
	) {

		console.log(
			'Reservation already released:',
			sessionId,
		);

		return false;

	}


	/*
	 * If payment already fulfilled it,
	 * do NOT return the stock.
	 */

	if (
		reservation.status ===
		'fulfilled'
	) {

		console.log(
			'Reservation already fulfilled:',
			sessionId,
		);

		return false;

	}


	if (
		!reservation.items_json
	) {

		throw new Error(
			'Reservation has no items_json.',
		);

	}


	const items =
		JSON.parse(
			reservation.items_json as string,
		) as ReservationItem[];


	/*
	 * Build one atomic D1 batch.
	 *
	 * Either all stock is returned and the reservation
	 * becomes released, or none of the changes happen.
	 */

	const statements = [];


	for (const item of items) {

		statements.push(
			db
				.prepare(
					`
					UPDATE inventory
					SET stock = stock + ?
					WHERE slug = ?
					`,
				)
				.bind(
					item.quantity,
					item.slug,
				),
		);

	}


	statements.push(
		db
			.prepare(
				`
				UPDATE reservations
				SET status = 'released'
				WHERE stripe_session_id = ?
				  AND status = 'reserved'
				`,
			)
			.bind(sessionId),
	);


	await db.batch(
		statements,
	);


	console.log(
		'RESERVATION RELEASED',
		{
			sessionId,
			items,
		},
	);


	return true;

}


/* =========================================================
   WEBHOOK
   ========================================================= */

export const POST: APIRoute = async ({
	request,
	locals,
}) => {

	try {

		/* =====================================================
		   CLOUDFLARE ENVIRONMENT
		   ===================================================== */

		const runtime =
			(locals as any).runtime;

		const env =
			runtime?.env;


		if (!env?.STRIPE_SECRET_KEY) {

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


		if (!env?.STRIPE_WEBHOOK_SECRET) {

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


		if (!env?.DB) {

			console.error(
				'D1 database binding DB is missing.',
			);

			return json(
				{
					error:
						'Database is not configured.',
				},
				500,
			);

		}


		/* =====================================================
		   STRIPE SIGNATURE
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
		   RAW BODY
		   ===================================================== */

		const payload =
			await request.text();


		/* =====================================================
		   VERIFY SIGNATURE
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
		   HANDLE EXPIRED CHECKOUT
		   ===================================================== */

		if (
			event.type ===
			'checkout.session.expired'
		) {

			const session =
				event.data.object;


			if (!session.id) {

				throw new Error(
					'Expired Checkout Session has no ID.',
				);

			}


			await releaseReservation(
				env.DB,
				session.id,
			);


			return json({
				received: true,
			});

		}


		/* =====================================================
		   IGNORE OTHER EVENTS
		   ===================================================== */

		if (
			event.type !==
			'checkout.session.completed'
		) {

			return json({
				received: true,
			});

		}


		/* =====================================================
		   COMPLETED CHECKOUT
		   ===================================================== */

		const session =
			event.data.object;


		if (!session.id) {

			throw new Error(
				'Stripe Checkout Session has no ID.',
			);

		}


		/* =====================================================
		   DUPLICATE PROTECTION
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
				'Order already exists:',
				session.id,
			);

			return json({
				received: true,
				duplicate: true,
			});

		}


		/* =====================================================
		   GET STRIPE LINE ITEMS
		   ===================================================== */

		const stripeItems =
			await getStripeLineItems(
				session.id,
				env,
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

		const items =
			stripeItems.map(
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

		const orderNumber =
			await getNextOrderNumber(
				env.DB,
			);


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
		   FULFILL RESERVATION
		   ===================================================== */

		const reservationId =
			session.metadata
				?.reservation_id;


		if (reservationId) {

			await env.DB
				.prepare(
					`
					UPDATE reservations
					SET stripe_session_id = ?,
					    status = 'fulfilled'
					WHERE stripe_session_id = ?
					  AND status = 'reserved'
					`,
				)
				.bind(
					session.id,
					reservationId,
				)
				.run();

		}


		/* =====================================================
		   SUCCESS LOG
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
