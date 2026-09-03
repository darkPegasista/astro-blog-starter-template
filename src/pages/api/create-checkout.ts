interface Env {
	STRIPE_SECRET_KEY: string;
	SITE_URL: string;
}

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

export const onRequestPost: PagesFunction<Env> = async ({
	request,
	env,
}) => {

	try {

		const body = await request.json() as {
			items?: CartItem[];
		};

		if (
			!Array.isArray(body.items) ||
			body.items.length === 0
		) {
			return json(
				{ error: 'Your cart is empty.' },
				400,
			);
		}


		const lineItems: string[] = [];

		let highestShippingClass:
			| 'tracked-letter'
			| 'tracked-small'
			| 'tracked-parcel'
			= 'tracked-letter';


		for (const item of body.items) {

			if (
				typeof item.slug !== 'string' ||
				!Number.isInteger(item.quantity) ||
				item.quantity < 1
			) {
				return json(
					{ error: 'Invalid cart item.' },
					400,
				);
			}


			const product =
				PRODUCTS[item.slug as ProductSlug];


			if (!product) {
				return json(
					{ error: 'One of the products is no longer available.' },
					400,
				);
			}


			if (item.quantity > product.stock) {
				return json(
					{
						error:
							`${product.name} is only available in the current stock quantity.`,
					},
					400,
				);
			}


			if (
				product.shippingClass ===
				'tracked-small'
			) {

				if (
					highestShippingClass ===
					'tracked-letter'
				) {
					highestShippingClass =
						'tracked-small';
				}

			}


			lineItems.push(
				`line_items[${lineItems.length}][price_data][currency]=eur`,
			);

			lineItems.push(
				`line_items[${lineItems.length - 1}][price_data][product_data][name]=${encodeURIComponent(product.name)}`,
			);

			lineItems.push(
				`line_items[${lineItems.length - 1}][price_data][unit_amount]=${product.price}`,
			);

			lineItems.push(
				`line_items[${lineItems.length - 1}][quantity]=${item.quantity}`,
			);

		}


		/*
		 * Five or more bucket hats require
		 * parcel packaging.
		 */

		const bucketHatQuantity =
			body.items
				.filter(
					(item) =>
						[
							'pony-princesses',
							'six-best-friends',
							'musician-ponies',
							'villains-of-harmony',
						].includes(item.slug),
				)
				.reduce(
					(total, item) =>
						total + item.quantity,
					0,
				);


		if (bucketHatQuantity >= 3) {
			highestShippingClass =
				'tracked-parcel';
		}


		const shipping =
			SHIPPING[highestShippingClass];


		lineItems.push(
			`shipping_options[0][shipping_rate_data][type]=fixed_amount`,
		);

		lineItems.push(
			`shipping_options[0][shipping_rate_data[fixed_amount][amount]=${shipping.amount}`,
		);

		lineItems.push(
			`shipping_options[0][shipping_rate_data[fixed_amount][currency]=eur`,
		);

		lineItems.push(
			`shipping_options[0][shipping_rate_data[display_name]=${encodeURIComponent(shipping.name)}`,
		);

		lineItems.push(
			`shipping_address_collection[allowed_countries][0]=DE`,
		);

		lineItems.push(
			`mode=payment`,
		);

		lineItems.push(
			`success_url=${encodeURIComponent(
				`${env.SITE_URL}/checkout/success?session_id={CHECKOUT_SESSION_ID}`,
			)}`,
		);

		lineItems.push(
			`cancel_url=${encodeURIComponent(
				`${env.SITE_URL}/cart`,
			)}`,
		);

		lineItems.push(
			`billing_address_collection=auto`,
		);

		lineItems.push(
			`metadata[cart_source]=lunar_visuals`,
		);


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
						lineItems.join('&'),
				},
			);


		const session =
			await response.json() as {
				id?: string;
				url?: string;
				error?: {
					message?: string;
				};
			};


		if (!response.ok || !session.url) {

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


		return json({
			url: session.url,
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
