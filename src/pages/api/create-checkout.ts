import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';

interface CartItem {
	slug: string;
	quantity: number;
}

const PRODUCTS = {
	'wine-pony-cheers': {
		name: 'Wine Pony Cheers',
		price: 1200,
		stock: 1,
		shippingClass: 'tracked-small',
	},

	'dont-drink-and-fly': {
		name: "Don't Drink and Fly",
		price: 1200,
		stock: 1,
		shippingClass: 'tracked-small',
	},

	'pony-princesses': {
		name: 'Pony Princesses',
		price: 3500,
		stock: 1,
		shippingClass: 'tracked-small',
	},

	'six-best-friends': {
		name: 'Six Best Friends',
		price: 3500,
		stock: 1,
		shippingClass: 'tracked-small',
	},

	'musician-ponies': {
		name: 'Musician Ponies',
		price: 3500,
		stock: 1,
		shippingClass: 'tracked-small',
	},

	'villains-of-harmony': {
		name: 'Villains of Harmony',
		price: 3500,
		stock: 1,
		shippingClass: 'tracked-small',
	},

	'socialist-pony-propaganda': {
		name: 'Socialist Pony Propaganda',
		price: 1500,
		stock: 1,
		shippingClass: 'tracked-small',
	},

	'drama-unicorn': {
		name: 'Drama Unicorn',
		price: 500,
		stock: 1,
		shippingClass: 'tracked-letter',
	},

	'cider-dash': {
		name: 'Cider Dash',
		price: 500,
		stock: 1,
		shippingClass: 'tracked-letter',
	},
} as const;

type ProductSlug = keyof typeof PRODUCTS;

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


function json(
	data: unknown,
	status = 200,
): Response {

	return new Response(
		JSON.stringify(data),
		{
			status,
			headers: {
				'Content-Type': 'application/json',
			},
		},
	);

}


export const POST: APIRoute = async ({
	request,
	locals,
}) => {

	try {

		/*
		 * Get Cloudflare environment variables.
		 */

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


		/*
		 * Read cart.
		 */

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


		/*
		 * Determine shipping class.
		 */

		let highestShippingClass:
			| 'tracked-letter'
			| 'tracked-small'
			| 'tracked-parcel'
			= 'tracked-letter';


		let bucketHatQuantity = 0;


		for (const item of body.items) {

			/*
			 * Validate quantity.
			 */

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


			/*
			 * Find product.
			 */

			const product =
				PRODUCTS[
					item.slug as ProductSlug
				];


			if (!product) {

				return json(
					{
						error:
							'One of the products is no longer available.',
					},
					400,
				);

			}


			/*
			 * Check stock.
			 */

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


			/*
			 * Determine basic shipping class.
			 */

			if (
				product.shippingClass ===
				'tracked-small'
			) {

				highestShippingClass =
					'tracked-small';

			}


			/*
			 * Count bucket hats.
			 */

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

		}


		/*
		 * Three or more bucket hats
		 * require parcel shipping.
		 */

		if (
			bucketHatQuantity >= 3
		) {

			highestShippingClass =
				'tracked-parcel';

		}


		const shipping =
			SHIPPING[highestShippingClass];


		/*
		 * Build Stripe request.
		 *
		 * URLSearchParams is used here instead
		 * of manually constructing the form body.
		 */

		const stripeParams =
			new URLSearchParams();


		/*
		 * Products.
		 */

		body.items.forEach(
			(item, index) => {

				const product =
					PRODUCTS[
						item.slug as ProductSlug
					];


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


		/*
		 * Shipping.
		 */

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


		/*
		 * Germany only.
		 */

		stripeParams.set(
			'shipping_address_collection[allowed_countries][0]',
			'DE',
		);


		/*
		 * Checkout settings.
		 */

		stripeParams.set(
			'mode',
			'payment',
		);

		stripeParams.set(
			'billing_address_collection',
			'auto',
		);


		/*
		 * Return URLs.
		 */

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


		/*
		 * Metadata.
		 */

		stripeParams.set(
			'metadata[cart_source]',
			'lunar_visuals',
		);


		/*
		 * Create Stripe Checkout Session.
		 */

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


		/*
		 * Stripe should always return JSON.
		 */

		if (!response.ok) {

			console.error(
				'Stripe error:',
				responseText,
			);

			return json(
				{
					error:
						'Stripe could not create the checkout session.',
				},
				500,
			);

		}


		const session =
			JSON.parse(
				responseText,
			) as {
				url?: string;
			};


		if (!session.url) {

			console.error(
				'Stripe response contained no checkout URL:',
				responseText,
			);

			return json(
				{
					error:
						'Stripe did not return a checkout URL.',
				},
				500,
			);

		}


		/*
		 * Send checkout URL back to cart.
		 */

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
