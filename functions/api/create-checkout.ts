interface Env {
	STRIPE_SECRET_KEY: string;
	SITE_URL: string;
}

interface CartItem {
	slug: string;
	quantity: number;
}


/* =========================================================
   PRODUCT CATALOGUE
   ========================================================= */

const PRODUCTS = {

	'wine-pony-cheers': {
		name: 'Wine Pony Cheers',
		price: 1200,
		stock: 1,
		shippingClass: 'small',
	},

	'dont-drink-and-fly': {
		name: "Don't Drink and Fly",
		price: 1200,
		stock: 1,
		shippingClass: 'small',
	},

	'pony-princesses': {
		name: 'Pony Princesses',
		price: 3500,
		stock: 1,
		shippingClass: 'small',
	},

	'six-best-friends': {
		name: 'Six Best Friends',
		price: 3500,
		stock: 1,
		shippingClass: 'small',
	},

	'musician-ponies': {
		name: 'Musician Ponies',
		price: 3500,
		stock: 1,
		shippingClass: 'small',
	},

	'villains-of-harmony': {
		name: 'Villains of Harmony',
		price: 3500,
		stock: 1,
		shippingClass: 'small',
	},

	'socialist-pony-propaganda': {
		name: 'Socialist Pony Propaganda',
		price: 1500,
		stock: 1,
		shippingClass: 'small',
	},

	'drama-unicorn': {
		name: 'Drama Unicorn',
		price: 500,
		stock: 1,
		shippingClass: 'letter',
	},

	'cider-dash': {
		name: 'Cider Dash',
		price: 500,
		stock: 1,
		shippingClass: 'letter',
	},

} as const;


type ProductSlug =
	keyof typeof PRODUCTS;


/* =========================================================
   SHIPPING RATES
   ========================================================= */

const SHIPPING_RATES = {

	letter: {
		name: 'Tracked shipping',
		amount: 390,
	},

	small: {
		name: 'Tracked shipping',
		amount: 490,
	},

	parcel: {
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
   CHECKOUT
   ========================================================= */

export const onRequestPost: PagesFunction<Env> =
	async ({ request, env }) => {

		try {

			const body =
				await request.json() as {
					items?: CartItem[];
				};


			/* -----------------------------------------
			   Validate cart
			   ----------------------------------------- */

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


			/* -----------------------------------------
			   Determine shipping
			   ----------------------------------------- */

			let shippingClass:
				'letter' |
				'small' |
				'parcel' =
					'letter';


			const lineItems: {
				price_data: {
					currency: string;
					product_data: {
						name: string;
					};
					unit_amount: number;
				};
				quantity: number;
			}[] = [];


			let bucketHatQuantity = 0;


			/* -----------------------------------------
			   Process products
			   ----------------------------------------- */

			for (
				const item of body.items
			) {

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


				const product =
					PRODUCTS[
						item.slug as ProductSlug
					];


				if (!product) {

					return json(
						{
							error:
								'One of the products in your cart is no longer available.',
						},
						400,
					);

				}


				/* -------------------------------------
				   Stock validation
				   ------------------------------------- */

				if (
					item.quantity >
					product.stock
				) {

					return json(
						{
							error:
								`${product.name} is only available in the current stock quantity.`,
						},
						400,
					);

				}


				/* -------------------------------------
				   Shipping class
				   ------------------------------------- */

				if (
					product.shippingClass ===
					'small'
				) {

					shippingClass =
						'small';

				}


				/* -------------------------------------
				   Count bucket hats
				   ------------------------------------- */

				const bucketHatSlugs = [
					'pony-princesses',
					'six-best-friends',
					'musician-ponies',
					'villains-of-harmony',
				];


				if (
					bucketHatSlugs.includes(
						item.slug,
					)
				) {

					bucketHatQuantity +=
						item.quantity;

				}


				/* -------------------------------------
				   Stripe line item
				   ------------------------------------- */

				lineItems.push(
	`shipping_options[0][shipping_rate_data][type]=fixed_amount`,
);

lineItems.push(
	`shipping_options[0][shipping_rate_data][fixed_amount][amount]=${shipping.amount}`,
);

lineItems.push(
	`shipping_options[0][shipping_rate_data][fixed_amount][currency]=eur`,
);

lineItems.push(
	`shipping_options[0][shipping_rate_data][display_name]=${encodeURIComponent(shipping.name)}`,
);


			/* -----------------------------------------
			   Three or more bucket hats
			   require parcel shipping
			   ----------------------------------------- */

			if (
				bucketHatQuantity >= 3
			) {

				shippingClass =
					'parcel';

			}


			const shipping =
				SHIPPING_RATES[
					shippingClass
				];


			/* =================================================
			   BUILD STRIPE REQUEST
			   ================================================= */

			const params =
				new URLSearchParams();


			/* -----------------------------------------
			   Line items
			   ----------------------------------------- */

			lineItems.forEach(
				(item, index) => {

					params.append(
						`line_items[${index}][price_data][currency]`,
						item.price_data.currency,
					);

					params.append(
						`line_items[${index}][price_data][product_data][name]`,
						item.price_data.product_data.name,
					);

					params.append(
						`line_items[${index}][price_data][unit_amount]`,
						item.price_data.unit_amount.toString(),
					);

					params.append(
						`line_items[${index}][quantity]`,
						item.quantity.toString(),
					);

				},
			);


			/* -----------------------------------------
			   Shipping
			   ----------------------------------------- */

			params.append(
				'shipping_options[0][shipping_rate_data][type]',
				'fixed_amount',
			);

			params.append(
				'shipping_options[0][shipping_rate_data][display_name]',
				shipping.name,
			);

			params.append(
				'shipping_options[0][shipping_rate_data][fixed_amount][amount]',
				shipping.amount.toString(),
			);

			params.append(
				'shipping_options[0][shipping_rate_data][fixed_amount][currency]',
				'eur',
			);


			/* -----------------------------------------
			   Germany only
			   ----------------------------------------- */

			params.append(
				'shipping_address_collection[allowed_countries][0]',
				'DE',
			);


			/* -----------------------------------------
			   Checkout mode
			   ----------------------------------------- */

			params.append(
				'mode',
				'payment',
			);


			/* -----------------------------------------
			   Billing address
			   ----------------------------------------- */

			params.append(
				'billing_address_collection',
				'auto',
			);


			/* -----------------------------------------
			   Redirect URLs
			   ----------------------------------------- */

			params.append(
				'success_url',
				`${env.SITE_URL}/checkout/success?session_id={CHECKOUT_SESSION_ID}`,
			);

			params.append(
				'cancel_url',
				`${env.SITE_URL}/cart`,
			);


			/* -----------------------------------------
			   Metadata
			   ----------------------------------------- */

			params.append(
				'metadata[cart_source]',
				'lunar_visuals',
			);


			/* =================================================
			   CREATE STRIPE SESSION
			   ================================================= */

			const stripeResponse =
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
							params.toString(),

					},
				);


			const session =
				await stripeResponse.json() as {

					id?: string;

					url?: string;

					error?: {
						message?: string;
					};

				};


			/* -----------------------------------------
			   Stripe error
			   ----------------------------------------- */

			if (
				!stripeResponse.ok ||
				!session.url
			) {

				console.error(
					'Stripe error:',
					session,
				);

				return json(
					{
						error:
							'Could not create the checkout session.',
					},
					500,
				);

			}


			/* -----------------------------------------
			   Return checkout URL
			   ----------------------------------------- */

			return json({

				url:
					session.url,

			});


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
