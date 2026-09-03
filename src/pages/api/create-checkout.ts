import type { APIRoute } from 'astro';

export const prerender = false;


/* =========================================================
   TYPES
   ========================================================= */

interface CartItem {
	slug: string;
	quantity: number;
}


interface Product {
	name: string;
	price: number;
	shippingClass:
		| 'tracked-letter'
		| 'tracked-small';
}


/* =========================================================
   PHYSICAL PRODUCTS
   =========================================================
   
   Stock is intentionally NOT stored here anymore.
   D1 inventory is now the source of truth.
   ========================================================= */

const PRODUCTS: Record<string, Product> = {

	'wine-pony-cheers': {
		name: 'Wine Pony Cheers',
		price: 1200,
		shippingClass: 'tracked-small',
	},

	'dont-drink-and-fly': {
		name: "Don't Drink and Fly",
		price: 1200,
		shippingClass: 'tracked-small',
	},

	'pony-princesses': {
		name: 'Pony Princesses',
		price: 3500,
		shippingClass: 'tracked-small',
	},

	'six-best-friends': {
		name: 'Six Best Friends',
		price: 3500,
		shippingClass: 'tracked-small',
	},

	'musician-ponies': {
		name: 'Musician Ponies',
		price: 3500,
		shippingClass: 'tracked-small',
	},

	'villains-of-harmony': {
		name: 'Villains of Harmony',
		price: 3500,
		shippingClass: 'tracked-small',
	},

	'socialist-pony-propaganda': {
		name: 'Socialist Pony Propaganda',
		price: 1500,
		shippingClass: 'tracked-small',
	},

	'drama-unicorn': {
		name: 'Drama Unicorn',
		price: 500,
		shippingClass: 'tracked-letter',
	},

	'cider-dash': {
		name: 'Cider Dash',
		price: 500,
		shippingClass: 'tracked-letter',
	},

};


/* =========================================================
   SHIPPING
   ========================================================= */

const SHIPPING = {

	'tracked-letter': {
		name: 'Tracked shipping',
		amount: 390,
	},

	'tracked-small': {
		name: 'Tracked shipping',
		amount: 490,
	},

	'tracked-parcel': {
		name: 'Tracked parcel shipping',
		amount: 790,
	},

} as const;


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
   POST
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
						'Stripe configuration is missing.',
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
						'Inventory database is not configured.',
				},
				500,
			);

		}


		/* =====================================================
		   READ CART
		   ===================================================== */

		const body =
			await request.json() as {
				items?: CartItem[];
			};


		if (
			!Array.isArray(body.items) ||
			body.items.length === 0
		) {

			return json(
				{
					error:
						'Your cart is empty.',
				},
				400,
			);

		}


		/* =====================================================
		   VALIDATE CART
		   ===================================================== */

		const cartItems: CartItem[] = [];


		let highestShippingClass:
			| 'tracked-letter'
			| 'tracked-small'
			| 'tracked-parcel'
			= 'tracked-letter';


		let bucketHatQuantity = 0;


		for (const item of body.items) {

			/* -------------------------------------------------
			   Validate quantity
			   ------------------------------------------------- */

			if (
				typeof item.slug !== 'string' ||
				!Number.isInteger(item.quantity) ||
				item.quantity < 1
			) {

				return json(
					{
						error:
							'Invalid cart item.',
					},
					400,
				);

			}


			/* -------------------------------------------------
			   Find product
			   ------------------------------------------------- */

			const product =
				PRODUCTS[item.slug];


			if (!product) {

				return json(
					{
						error:
							'One of the products is no longer available.',
					},
					400,
				);

			}


			/* -------------------------------------------------
			   Determine shipping
			   ------------------------------------------------- */

			if (
				product.shippingClass ===
				'tracked-small'
			) {

				highestShippingClass =
					'tracked-small';

			}


			/* -------------------------------------------------
			   Count bucket hats
			   ------------------------------------------------- */

			if (
				[
					'pony-princesses',
					'six-best-friends',
					'musician-ponies',
					'villains-of-harmony',
				].includes(item.slug)
			) {

				bucketHatQuantity +=
					item.quantity;

			}


			cartItems.push({
				slug: item.slug,
				quantity: item.quantity,
			});

		}


		/* =====================================================
		   BUCKET HAT SHIPPING
		   ===================================================== */

		if (
			bucketHatQuantity >= 3
		) {

			highestShippingClass =
				'tracked-parcel';

		}


		const shipping =
			SHIPPING[highestShippingClass];


		/* =====================================================
		   RESERVE INVENTORY
		   =====================================================

		   We reserve the products BEFORE creating the Stripe
		   Checkout Session.

		   This prevents two customers from purchasing the
		   same limited item simultaneously.
		   ===================================================== */

		const reservationId =
			crypto.randomUUID();


		const reservationItems =
			JSON.stringify(cartItems);


		const reservationTime =
			new Date().toISOString();


		/*
		 * Build one atomic D1 transaction.
		 *
		 * Every stock update must succeed.
		 *
		 * If even ONE product doesn't have enough stock,
		 * the entire transaction fails.
		 */

		const statements = [];


		for (const item of cartItems) {

			statements.push(
				env.DB
					.prepare(
						`
						UPDATE inventory
						SET stock = stock - ?
						WHERE slug = ?
						  AND stock >= ?
						`,
					)
					.bind(
						item.quantity,
						item.slug,
						item.quantity,
					),
			);

		}


		/*
		 * Create the reservation record.
		 *
		 * The temporary reservation ID is stored in the
		 * database and will later be replaced by the Stripe
		 * Checkout Session ID.
		 */

		statements.push(
			env.DB
				.prepare(
					`
					INSERT INTO reservations (
						stripe_session_id,
						slug,
						quantity,
						status,
						created_at,
						items_json
					)
					VALUES (?, ?, ?, ?, ?, ?)
					`,
				)
				.bind(
					reservationId,
					'__pending__',
					0,
					'pending',
					reservationTime,
					reservationItems,
				),
		);


		try {

			const results =
				await env.DB.batch(
					statements,
				);


			/*
			 * Check every inventory UPDATE.
			 *
			 * D1 returns the number of rows changed.
			 */

			for (
				let i = 0;
				i < cartItems.length;
				i++
			) {

				const result =
					results[i];

				if (
					result.meta
						.changes !== 1
				) {

					throw new Error(
						`Insufficient stock for ${cartItems[i].slug}.`,
					);

				}

			}

		} catch (error) {

			console.error(
				'Inventory reservation failed:',
				error,
			);

			/*
			 * Because the inventory updates and reservation
			 * insert are part of one D1 batch, a failed
			 * reservation does not leave partial stock changes.
			 */

			return json(
				{
					error:
						'One or more products are no longer available in the requested quantity.',
				},
				409,
			);

		}


		/* =====================================================
		   BUILD STRIPE CHECKOUT REQUEST
		   ===================================================== */

		const stripeParams =
			new URLSearchParams();


		/* -----------------------------------------------------
		   PRODUCTS
		   ----------------------------------------------------- */

		cartItems.forEach(
			(item, index) => {

				const product =
					PRODUCTS[item.slug];


				stripeParams.set(
					`line_items[${index}][price_data][currency]`,
					'eur',
				);


				stripeParams.set(
					`line_items[${index}][price_data][product_data][name]`,
					product.name,
				);


				stripeParams.set(
					`line_items[${index}][price_data][unit_amount]`,
					String(product.price),
				);


				stripeParams.set(
					`line_items[${index}][quantity]`,
					String(item.quantity),
				);

			},
		);


		/* -----------------------------------------------------
		   SHIPPING
		   ----------------------------------------------------- */

		stripeParams.set(
			'shipping_options[0][shipping_rate_data][type]',
			'fixed_amount',
		);


		stripeParams.set(
			'shipping_options[0][shipping_rate_data][fixed_amount][amount]',
			String(shipping.amount),
		);


		stripeParams.set(
			'shipping_options[0][shipping_rate_data][fixed_amount][currency]',
			'eur',
		);


		stripeParams.set(
			'shipping_options[0][shipping_rate_data][display_name]',
			shipping.name,
		);


		/* -----------------------------------------------------
		   GERMANY ONLY
		   ----------------------------------------------------- */

		stripeParams.set(
			'shipping_address_collection[allowed_countries][0]',
			'DE',
		);


		/* -----------------------------------------------------
		   CHECKOUT SETTINGS
		   ----------------------------------------------------- */

		stripeParams.set(
			'mode',
			'payment',
		);


		stripeParams.set(
			'billing_address_collection',
			'auto',
		);


		/* -----------------------------------------------------
		   RETURN URLS
		   ----------------------------------------------------- */

		const siteUrl =
			new URL(
				request.url,
			).origin;


		stripeParams.set(
			'success_url',
			`${siteUrl}/checkout/success?session_id={CHECKOUT_SESSION_ID}`,
		);


		stripeParams.set(
			'cancel_url',
			`${siteUrl}/cart`,
		);


		/* -----------------------------------------------------
		   METADATA
		   ----------------------------------------------------- */

		stripeParams.set(
			'metadata[cart_source]',
			'lunar_visuals',
		);


		/*
		 * Store the temporary reservation ID so that the
		 * webhook knows which reservation belongs to this
		 * Checkout Session.
		 */

		stripeParams.set(
			'metadata[reservation_id]',
			reservationId,
		);


		/* =====================================================
		   CREATE STRIPE SESSION
		   ===================================================== */

		let stripeSessionId:
			| string
			| null = null;


		try {

			const response =
				await fetch(
					'https://api.stripe.com/v1/checkout/sessions',
					{
						method: 'POST',

						headers: {
							'Authorization':
								`Bearer ${env.STRIPE_SECRET_KEY}`,

							'Content-Type':
								'application/x-www-form-urlencoded',
						},

						body:
							stripeParams.toString(),
					},
				);


			const responseText =
				await response.text();


			if (!response.ok) {

				console.error(
					'Stripe error:',
					responseText,
				);

				throw new Error(
					'Stripe could not create checkout session.',
				);

			}


			const session =
				JSON.parse(
					responseText,
				) as {
					id?: string;
					url?: string;
				};


			if (
				!session.id ||
				!session.url
			) {

				throw new Error(
					'Stripe did not return a valid checkout session.',
				);

			}


			stripeSessionId =
				session.id;


			/* =================================================
			   UPDATE RESERVATION WITH REAL STRIPE SESSION ID
			   ================================================= */

			await env.DB
				.prepare(
					`
					UPDATE reservations
					SET stripe_session_id = ?,
					    status = 'reserved'
					WHERE stripe_session_id = ?
					`,
				)
				.bind(
					stripeSessionId,
					reservationId,
				)
				.run();


			/* =================================================
			   RETURN CHECKOUT URL
			   ================================================= */

			return json({
				url:
					session.url,
			});


		} catch (error) {

			console.error(
				'Stripe checkout creation failed:',
				error,
			);


			/* =================================================
			   RELEASE INVENTORY IF STRIPE FAILED
			   ================================================= */

			try {

				for (const item of cartItems) {

					await env.DB
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
						)
						.run();

				}


				await env.DB
					.prepare(
						`
						UPDATE reservations
						SET status = 'cancelled'
						WHERE stripe_session_id = ?
						`,
					)
					.bind(
						reservationId,
					)
					.run();


			} catch (releaseError) {

				console.error(
					'CRITICAL: Could not release inventory:',
					releaseError,
				);

			}


			return json(
				{
					error:
						'Stripe could not create the checkout session.',
				},
				500,
			);

		}

	} catch (error) {

		console.error(
			'Checkout error:',
			error,
		);

		return json(
			{
				error:
					'Something went wrong while starting checkout.',
			},
			500,
		);

	}

};
