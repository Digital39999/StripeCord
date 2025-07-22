import { Addon, AddonUpdateType, ChargeOptions, CollectionMethod, CustomerCreateData, CustomerQueryData, CustomerUpdateData, InvoiceNeedsPayment, InvoicePaymentFailed, PaymentStatus, PremiumTier, StripeAddon, StripeTier, SubscriptionCreateInputData, WebhookResponse, WhatHappened, WithQuantity } from '../types';
import { getYearlyMultiplier, stringifyError } from '../utils';
import { PremiumManager } from './manager';
import Stripe from 'stripe';

export default class StripeManager {
	readonly stripe: Stripe;

	public tiers: StripeTiers;
	public addons: StripeAddons;

	public customers: StripeCustomers;
	public subscriptions: StripeSubscriptions;

	private stripeWebhookSecret: string | null = null;

	constructor (private readonly manager: PremiumManager) {
		if (!manager.config.stripeApiKey) throw new Error('Missing Stripe API key.');
		else if (!manager.config.stripeWebhookUrl) throw new Error('Missing Stripe webhook url.');

		this.stripe = new Stripe(manager.config.stripeApiKey);

		this.tiers = new StripeTiers(manager, this.stripe);
		this.addons = new StripeAddons(manager, this.stripe);

		this.customers = new StripeCustomers(manager, this.stripe);
		this.subscriptions = new StripeSubscriptions(manager, this.stripe, this);

		this.stripeWebhookSecret = this.manager.config.stripeWebhookSecret || null;
	}

	public async syncAll() {
		await this.validateWebhook();
		await this.tiers.syncOrCreateTiers();
		await this.addons.syncOrCreateAddons();
	}

	private async validateWebhook() {
		if (this.stripeWebhookSecret) {
			this.manager.emit('debug', 'Webhook secret already exists, skipping validation.');
			return;
		}

		const pastWebhooks = await this.stripe.webhookEndpoints.list();
		const webhook = pastWebhooks.data.filter((wh) => wh.url === this.manager.config.stripeWebhookUrl || wh.metadata._internal === 'StripeCord');

		for (const wh of webhook) await this.stripe.webhookEndpoints.del(wh.id).catch((err) => {
			this.manager.emit('debug', `Failed to delete webhook with ID ${wh.id}: ${stringifyError(err)}`);
		}).then(() => {
			this.manager.emit('debug', `Deleted webhook with ID ${wh.id}.`);
		});

		const newWebhook = await this.stripe.webhookEndpoints.create({
			url: this.manager.config.stripeWebhookUrl,
			enabled_events: [
				'invoice.paid',
				'customer.subscription.updated',
				'customer.subscription.deleted',
				'invoice.finalized',
				'invoice.payment_failed',
				'invoice.payment_action_required',
				'radar.early_fraud_warning.created',
				'charge.dispute.funds_withdrawn',
				'charge.dispute.created',
			],
			metadata: {
				_internal: 'StripeCord',
			},
		});

		this.manager.emit('debug', `Created webhook with ID ${newWebhook.id}.`);

		if (!newWebhook.secret) throw new Error('Failed to create webhook secret.');
		this.stripeWebhookSecret = newWebhook.secret;
		return newWebhook;
	}

	public async webhookHandler(payload: string | Buffer, signature: string): Promise<WebhookResponse> {
		if (!this.stripeWebhookSecret) throw new Error('Failed to validate webhook, have you called validateWebhook()?');

		let event: Stripe.Event;

		try {
			event = await this.stripe.webhooks.constructEventAsync(payload, signature, this.stripeWebhookSecret);
		} catch (error) {
			this.manager.emit('unprocessedWebhook', payload);
			throw new Error(`Invalid Stripe webhook: ${stringifyError(error)}`);
		}

		switch (event.type) {
			case 'invoice.paid': {
				const invoice: { data: null | Stripe.Invoice; } = { data: null };

				if (typeof event.data.object === 'string') invoice.data = await this.stripe.invoices.retrieve(event.data.object).catch(() => null);
				else invoice.data = event.data.object;

				if (!invoice.data || !invoice.data?.subscription) return {
					status: 400,
					message: 'Missing subscription data.',
				};

				if (invoice.data.subscription) {
					const subscription: { data: null | Stripe.Subscription; } = { data: null };

					if (typeof invoice.data.subscription === 'string') subscription.data = await this.stripe.subscriptions.retrieve(invoice.data.subscription).catch(() => null);
					else subscription.data = invoice.data.subscription;

					if (!subscription.data) return { status: 400, message: 'Failed to retrieve subscription data.' };
					else if (
						!subscription.data.metadata.tierId ||
						!subscription.data.metadata.userId ||
						(
							!subscription.data.metadata.guildId &&
							!subscription.data.metadata.isUserSub
						)
					) return { status: 400, message: 'Missing metadata in subscription.' };

					const isUserSubscription = subscription.data.metadata.isUserSub === 'true';
					const subscriptionType = isUserSubscription ? 'user' : 'guild';

					const tierData = this.manager.config.premiumTiers.find((tier) => tier.tierId === subscription.data?.metadata.tierId);
					if (!tierData) return { status: 400, message: `Tier not found for ID ${subscription.data.metadata.tierId} locally (#1).` };

					switch (invoice.data.billing_reason) {
						case 'subscription_create': {
							const eventData = {
								type: subscriptionType,
								tier: tierData,

								isAnnual: subscription.data.metadata.isAnnual === 'true',
								addons: await this.addons.getAddonsFromItems(subscription.data.items.data) ?? [],

								userId: subscription.data.metadata.userId,
								guildId: subscription.data.metadata.guildId ?? null,

								raw: {
									subscription: subscription.data,
									invoice: invoice.data,
								},
							} as const;

							this.manager.emit('subscriptionCreate', eventData);
							break;
						}
						case 'subscription_cycle': {
							const eventData = {
								type: subscriptionType,
								tier: tierData,

								isAnnual: subscription.data.metadata.isAnnual === 'true',
								addons: await this.addons.getAddonsFromItems(subscription.data.items.data) ?? [],

								userId: subscription.data.metadata.userId,
								guildId: subscription.data.metadata.guildId ?? null,

								raw: {
									subscription: subscription.data,
									invoice: invoice.data,
								},
							} as const;

							this.manager.emit('subscriptionRenew', eventData);
							break;
						}
					}
				}

				break;
			}
			case 'customer.subscription.updated': {
				const subscription = { data: event.data.object, previous: event.data.previous_attributes };

				if (!subscription.data || !subscription.previous) return { status: 400, message: 'Missing subscription data.' };
				else if (
					!subscription.data.metadata.tierId ||
					!subscription.data.metadata.userId ||
					(
						!subscription.data.metadata.guildId &&
						!subscription.data.metadata.isUserSub
					)
				) return { status: 400, message: 'Missing metadata in subscription.' };

				const isUserSubscription = subscription.data.metadata.isUserSub === 'true';
				const subscriptionType = isUserSubscription ? 'user' : 'guild';

				const stripeAddons = await this.addons.getStripeAddons();
				const addonItems = await this.addons.getAddonsFromItems(subscription.data.items.data, stripeAddons) ?? [];

				const tierData = this.manager.config.premiumTiers.find((tier) => tier.tierId === subscription.data?.metadata.tierId);
				if (!tierData) return { status: 400, message: `Tier not found for ID ${subscription.data.metadata.tierId} locally (#2).` };

				if (subscription.data.status === 'canceled' && subscription.previous.status !== 'canceled') {
					const eventData = {
						type: subscriptionType,
						tier: tierData,

						isAnnual: subscription.data.metadata.isAnnual === 'true',
						addons: addonItems,

						userId: subscription.data.metadata.userId,
						guildId: subscription.data.metadata.guildId ?? null,

						raw: {
							subscription: subscription.data,
							previous: subscription.previous,
						},
					} as const;

					this.manager.emit('subscriptionCancel', eventData);
				}

				const downgradeOrUpgrade = await this.tiers.checkIfTierChange(subscription.data.items.data, subscription.previous.items?.data || []);
				if (downgradeOrUpgrade) {
					const newTierData = this.manager.config.premiumTiers.find((tier) => tier.tierId === downgradeOrUpgrade.newTierId);
					const oldTierData = this.manager.config.premiumTiers.find((tier) => tier.tierId === downgradeOrUpgrade.oldTierId);
					if (!newTierData || !oldTierData) return { status: 400, message: `Tier not found for ID ${downgradeOrUpgrade.newTierId} or ${downgradeOrUpgrade.oldTierId} locally (#3).` };

					const eventData = {
						type: subscriptionType,

						newTier: newTierData,
						oldTier: oldTierData,

						isAnnual: subscription.data.metadata.isAnnual === 'true',
						addons: addonItems,

						userId: subscription.data.metadata.userId,
						guildId: subscription.data.metadata.guildId ?? null,

						raw: {
							subscription: subscription.data,
							previous: subscription.previous,
						},
					} as const;

					this.manager.emit('subscriptionTierChange', eventData);
				}

				const addonsChange = await this.addons.checkIfAddonChange(subscription.data.items.data, subscription.previous.items?.data || [], stripeAddons);
				if (addonsChange) {
					const addonUpdates: AddonUpdateType[] = [];

					for (const changedQuantityAddons of addonsChange.changedQuantity) {
						const addon = addonItems.find((item) => item.addonId === changedQuantityAddons.addonId);
						if (!addon) continue;

						addonUpdates.push({ whatHappened: WhatHappened.Updated, addon, qty: changedQuantityAddons.quantity });
					}

					for (const newAddon of addonsChange.currentAddons) {
						const oldAddon = addonsChange.previousAddons.find((addon) => addon.addonId === newAddon.addonId);
						if (!oldAddon) addonUpdates.push({ whatHappened: WhatHappened.Added, addon: newAddon, qty: newAddon.quantity });
						else if (oldAddon.quantity !== newAddon.quantity) {
							const exists = addonUpdates.find((update) => update.addon.addonId === newAddon.addonId);
							if (!exists) addonUpdates.push({ whatHappened: WhatHappened.Updated, addon: newAddon, qty: newAddon.quantity });
						}
					}

					for (const oldAddon of addonsChange.previousAddons) {
						const newAddon = addonsChange.currentAddons.find((addon) => addon.addonId === oldAddon.addonId);
						if (!newAddon) addonUpdates.push({ whatHappened: WhatHappened.Removed, addon: oldAddon, qty: oldAddon.quantity });
					}

					const theRest = addonItems.filter((item) => !addonsChange.currentAddons.some((addon) => addon.addonId === item.addonId));
					for (const addon of theRest) addonUpdates.push({ whatHappened: WhatHappened.Nothing, addon, qty: addon.quantity });

					const eventData = {
						type: subscriptionType,
						tier: tierData,

						isAnnual: subscription.data.metadata.isAnnual === 'true',
						currentAddons: addonsChange.currentAddons,
						addonUpdates,

						userId: subscription.data.metadata.userId,
						guildId: subscription.data.metadata.guildId ?? null,

						raw: {
							subscription: subscription.data,
							previous: subscription.previous,
						},
					} as const;

					this.manager.emit('subscriptionAddonsUpdate', eventData);
				}

				const eventData = {
					type: subscriptionType,
					tier: tierData,

					isAnnual: subscription.data.metadata.isAnnual === 'true',
					addons: addonItems,

					userId: subscription.data.metadata.userId,
					guildId: subscription.data.metadata.guildId ?? null,

					raw: {
						subscription: subscription.data,
						previous: subscription.previous,
					},
				} as const;

				this.manager.emit('subscriptionUpdate', eventData);

				break;
			}
			case 'customer.subscription.deleted': {
				const subscription: { data: null | Stripe.Subscription; } = { data: null };

				if (typeof event.data.object === 'string') subscription.data = await this.stripe.subscriptions.retrieve(event.data.object).catch(() => null);
				else subscription.data = event.data.object;

				if (!subscription.data) return { status: 400, message: 'Failed to retrieve subscription data.' };
				else if (
					!subscription.data.metadata.tierId ||
					!subscription.data.metadata.userId ||
					(
						!subscription.data.metadata.guildId &&
						!subscription.data.metadata.isUserSub
					)
				) return { status: 400, message: 'Missing metadata in subscription.' };

				const isUserSubscription = subscription.data.metadata.isUserSub === 'true';
				const subscriptionType = isUserSubscription ? 'user' : 'guild';

				const tierData = this.manager.config.premiumTiers.find((tier) => tier.tierId === subscription.data?.metadata.tierId);
				if (!tierData) return { status: 400, message: `Tier not found for ID ${subscription.data.metadata.tierId} locally (#4).` };

				const eventData = {
					type: subscriptionType,
					tier: tierData,

					isAnnual: subscription.data.metadata.isAnnual === 'true',
					addons: await this.addons.getAddonsFromItems(subscription.data.items.data) ?? [],

					userId: subscription.data.metadata.userId,
					guildId: subscription.data.metadata.guildId ?? null,

					raw: {
						subscription: subscription.data,
					},
				} as const;

				this.manager.emit('subscriptionDelete', eventData);
				break;
			}
			case 'invoice.finalized': {
				const invoice: { data: null | Stripe.Invoice; } = { data: null };

				if (typeof event.data.object === 'string') invoice.data = await this.stripe.invoices.retrieve(event.data.object).catch(() => null);
				else invoice.data = event.data.object;

				if (!invoice.data || !invoice.data?.subscription) return { status: 400, message: 'Missing subscription data.' };
				else if (invoice.data.status && ['paid', 'void', 'uncollectible'].includes(invoice.data.status)) return { status: 200, message: 'Invoice already resolved.' };

				const ignoredBillingReasons = ['subscription_create', 'subscription_cycle'];
				if (invoice.data.billing_reason && ignoredBillingReasons.includes(invoice.data.billing_reason)) return { status: 200, message: 'Billing reason ignored.' };

				const needsPayment = invoice.data.status === 'open' && (invoice.data.collection_method === 'send_invoice' || (invoice.data.collection_method === 'charge_automatically' && invoice.data.lines.data.some((line) => line.proration)) || (invoice.data.attempt_count && invoice.data.attempt_count > 0));
				if (!needsPayment) return { status: 200, message: 'Invoice does not require immediate attention.' };

				const subscription: { data: null | Stripe.Subscription; } = { data: null };

				if (typeof invoice.data.subscription === 'string') subscription.data = await this.stripe.subscriptions.retrieve(invoice.data.subscription).catch(() => null);
				else subscription.data = invoice.data.subscription;

				if (!subscription.data) return { status: 400, message: 'Failed to retrieve subscription data.' };
				else if (
					!subscription.data.metadata.tierId ||
					!subscription.data.metadata.userId ||
					(
						!subscription.data.metadata.guildId &&
						!subscription.data.metadata.isUserSub
					)
				) return { status: 400, message: 'Missing metadata in subscription.' };

				const tierData = this.manager.config.premiumTiers.find((tier) => tier.tierId === subscription.data?.metadata.tierId);
				if (!tierData) return { status: 400, message: `Tier not found for ID ${subscription.data.metadata.tierId} locally.` };

				const isUserSubscription = subscription.data.metadata.isUserSub === 'true';
				const subscriptionType = isUserSubscription ? 'user' : 'guild';

				const shouldNotifyUser = invoice.data.status === 'open' && (invoice.data.collection_method === 'send_invoice' || (invoice.data.collection_method === 'charge_automatically' && invoice.data.hosted_invoice_url && !invoice.data.auto_advance));

				const eventData: InvoiceNeedsPayment = {
					type: subscriptionType,
					tier: tierData,

					isAnnual: subscription.data.metadata.isAnnual === 'true',
					addons: await this.addons.getAddonsFromItems(subscription.data.items.data) ?? [],

					status: PaymentStatus.PendingPayment,
					finalTotal: invoice.data.total,

					attemptCount: invoice.data.attempt_count || 0,
					autoHandled: !!invoice.data.auto_advance,
					collectionMethod: invoice.data.collection_method === 'charge_automatically' ? CollectionMethod.ChargeAutomatically : CollectionMethod.SendInvoice,

					shouldNotifyUser: !!shouldNotifyUser,
					hostedUrl: invoice.data.hosted_invoice_url ?? null,
					dueDate: invoice.data.due_date ? new Date(invoice.data.due_date * 1000) : null,

					userId: subscription.data.metadata.userId,
					guildId: subscription.data.metadata.guildId ?? null,

					raw: {
						subscription: subscription.data,
						invoice: invoice.data,
					},
				};

				this.manager.emit('invoiceNeedsPayment', eventData);
				break;
			}
			case 'invoice.payment_failed':
			case 'invoice.payment_action_required': {
				const invoice: { data: null | Stripe.Invoice; } = { data: null };

				if (typeof event.data.object === 'string') invoice.data = await this.stripe.invoices.retrieve(event.data.object).catch(() => null);
				else invoice.data = event.data.object;

				if (!invoice.data || !invoice.data?.subscription) return { status: 400, message: 'Missing subscription data.' };
				else if (invoice.data.status && ['paid', 'void', 'uncollectible'].includes(invoice.data.status)) return { status: 200, message: 'Invoice already resolved.' };

				const subscription: { data: null | Stripe.Subscription; } = { data: null };

				if (typeof invoice.data.subscription === 'string') subscription.data = await this.stripe.subscriptions.retrieve(invoice.data.subscription).catch(() => null);
				else subscription.data = invoice.data.subscription;

				if (!subscription.data) return { status: 400, message: 'Failed to retrieve subscription data.' };
				else if (
					!subscription.data.metadata.tierId ||
					!subscription.data.metadata.userId ||
					(
						!subscription.data.metadata.guildId &&
						!subscription.data.metadata.isUserSub
					)
				) return { status: 400, message: 'Missing metadata in subscription.' };

				const tierData = this.manager.config.premiumTiers.find((tier) => tier.tierId === subscription.data?.metadata.tierId);
				if (!tierData) return { status: 400, message: `Tier not found for ID ${subscription.data.metadata.tierId} locally (#5).` };

				const isUserSubscription = subscription.data.metadata.isUserSub === 'true';
				const subscriptionType = isUserSubscription ? 'user' : 'guild';

				let status: PaymentStatus;
				switch (event.type) {
					case 'invoice.payment_failed': status = PaymentStatus.PaymentFailed; break;
					case 'invoice.payment_action_required': status = PaymentStatus.RequiresAction; break;
				}

				const shouldNotifyUser = invoice.data.status === 'open' && (status === PaymentStatus.RequiresAction || (status === PaymentStatus.PaymentFailed && invoice.data.hosted_invoice_url));

				const eventData: InvoicePaymentFailed = {
					type: subscriptionType,
					tier: tierData,

					isAnnual: subscription.data.metadata.isAnnual === 'true',
					addons: await this.addons.getAddonsFromItems(subscription.data.items.data) ?? [],

					status: status,
					finalTotal: invoice.data.total,

					attemptCount: invoice.data.attempt_count || 0,
					autoHandled: !!invoice.data.auto_advance && invoice.data.collection_method === 'charge_automatically',
					collectionMethod: invoice.data.collection_method === 'charge_automatically' ? CollectionMethod.ChargeAutomatically : CollectionMethod.SendInvoice,

					shouldNotifyUser: !!shouldNotifyUser,
					hostedUrl: invoice.data.hosted_invoice_url ?? null,
					nextAttempt: invoice.data.next_payment_attempt ? new Date(invoice.data.next_payment_attempt * 1000) : null,

					userId: subscription.data.metadata.userId,
					guildId: subscription.data.metadata.guildId ?? null,

					raw: {
						subscription: subscription.data,
						invoice: invoice.data,
					},
				};

				this.manager.emit('invoicePaymentFailed', eventData);
				break;
			}
			case 'radar.early_fraud_warning.created': {
				this.manager.emit('earlyFraudWarning', event.data.object);

				if (event.data.object.actionable) await this.stripe.refunds.create({ charge: typeof event.data.object.charge === 'string' ? event.data.object.charge : event.data.object.charge.id });
				break;
			}
			case 'charge.dispute.funds_withdrawn': {
				const charge = await this.stripe.charges.retrieve(typeof event.data.object.charge === 'string' ? event.data.object.charge : event.data.object.charge.id, {
					expand: ['invoice.subscription'],
				}).catch(() => null);
				if (!charge) return { status: 400, message: 'Failed to retrieve charge data.' };

				const invoice = charge.invoice;
				if (!invoice || typeof invoice === 'string') return { status: 400, message: 'Failed to retrieve invoice data.' };

				const subscription = invoice.subscription;
				if (!subscription || typeof subscription === 'string') return { status: 400, message: 'Failed to retrieve subscription data.' };

				await this.stripe.subscriptions.cancel(subscription.id, { invoice_now: this.manager.config.options?.stripe?.invoiceAllOnDisputeLoss || false });

				break;
			}
			case 'charge.dispute.created': {
				const paymentIntentId = typeof event.data.object.payment_intent === 'string' ? event.data.object.payment_intent : event.data.object.payment_intent?.id;

				this.manager.emit('disputeWarning', {
					amount: event.data.object.amount,
					reason: event.data.object.reason,

					isRefundable: event.data.object.is_charge_refundable,
					dashboardUrl: 'https://dashboard.stripe.com' + (event.data.object.livemode ? '' : '/test') + '/payments/' + paymentIntentId,

					raw: {
						charge: typeof event.data.object.charge === 'string' ? await this.stripe.charges.retrieve(event.data.object.charge).catch(() => null) : event.data.object.charge,
						dispute: event.data.object,
					},
				});

				break;
			}
			default: {
				this.manager.emit('unprocessedWebhook', payload);
				return {
					status: 400,
					message: 'Unhandled Stripe webhook.',
				};
			}
		}

		return {
			status: 200,
			message: 'Webhook processed successfully.',
		};
	}

	public async internalGetAllProducts(options?: Stripe.ProductListParams, acc: Stripe.Product[] = [], startingAfter?: string): Promise<Stripe.Product[]> {
		const products = await this.stripe.products.list({ ...options, limit: 100, starting_after: startingAfter });
		acc.push(...products.data);

		if (products.has_more) return this.internalGetAllProducts(options, acc, products.data[products.data.length - 1]?.id);
		else return acc;
	}

	public async internalGetAllPrices(options?: Stripe.PriceListParams, acc: Stripe.Price[] = [], startingAfter?: string): Promise<Stripe.Price[]> {
		const prices = await this.stripe.prices.list({ ...options, limit: 100, starting_after: startingAfter });
		acc.push(...prices.data);

		if (prices.has_more) return this.internalGetAllPrices(options, acc, prices.data[prices.data.length - 1]?.id);
		else return acc;
	}
}

export class StripeTiers {
	constructor (private readonly manager: PremiumManager, private readonly stripe: Stripe) { }

	private async createTier(data: PremiumTier, allProducts: Stripe.Product[], allPrices: Stripe.Price[]): Promise<Stripe.Product> {
		if (data.priceCents <= 0) throw new Error(`Invalid price for tier ${data.tierId}: ${data.priceCents}.`);

		let product = allProducts.find((p) => p.metadata._internal_id === data.tierId && p.metadata._internal_type === data.type && p.metadata._internal_which === 'tier');

		if (!product) {
			product = await this.stripe.products.create({
				name: data.name,
				metadata: {
					_internal_type: data.type,
					_internal_id: data.tierId,
					_internal_which: 'tier',
				},
			});
		} else if (!product.active) {
			await this.stripe.products.update(product.id, { active: true, name: data.name });

			const productPrices = allPrices.filter((price) => price.product === product!.id).filter((price) => price.active === false);
			for await (const price of productPrices) await this.stripe.prices.update(price.id, { active: true });
		} else if (product.name !== data.name) {
			await this.stripe.products.update(product.id, { name: data.name });
		}

		const createOrUpdatePrice = async (interval: 'month' | 'year', amount: number): Promise<Stripe.Price> => {
			const existingPrice = allPrices.find((price) => price.unit_amount === amount && price.recurring?.interval === interval && price.product === product.id);

			if (existingPrice) {
				if (!existingPrice.active) await this.stripe.prices.update(existingPrice.id, { active: true });
				return existingPrice;
			}

			return await this.stripe.prices.create({
				unit_amount: amount,
				currency: data.currency ?? 'usd',
				product: product.id,
				active: data.isActive ?? true,
				tax_behavior: this.manager.config.options?.stripe?.includeTaxInPrice ? 'inclusive' : 'exclusive',
				recurring: {
					interval,
				},
				metadata: {
					_internal_type: data.type,
					_internal_id: data.tierId,
					_internal_which: 'tier',
				},
			});
		};

		const monthlyPrice = await createOrUpdatePrice('month', data.priceCents).catch(() => null);
		const yearlyPrice = await createOrUpdatePrice('year', data.priceCents * getYearlyMultiplier(data.yearlyMultiplier)).catch(() => null);
		if (!monthlyPrice || !yearlyPrice) throw new Error('Failed to create or update prices for tier.');

		await this.stripe.products.update(product.id, { default_price: monthlyPrice.id });
		return product;
	}

	public async getStripeTiers(): Promise<StripeTier[]> {
		return this.getStripeTiersInternal();
	}

	private async getStripeTiersInternal(getExtra?: boolean, internalAllProducts?: Stripe.Product[], internalAllPrices?: Stripe.Price[]): Promise<StripeTier[]> {
		const allProducts = internalAllProducts || await this.manager.stripeManager.internalGetAllProducts();
		const allPrices = internalAllPrices || await this.manager.stripeManager.internalGetAllPrices();

		const tiers: StripeTier[] = [];

		for await (const product of allProducts) {
			const monthlyPrice = allPrices.find((price) => price.recurring?.interval === 'month' && price.product === product.id);
			const yearlyPrice = allPrices.find((price) => price.recurring?.interval === 'year' && price.product === product.id);
			if (!monthlyPrice || !yearlyPrice) continue;

			const tierId = product.metadata._internal_id;
			const tierType = product.metadata._internal_type;
			const tierWhich = product.metadata._internal_which;

			if (!tierId || !tierType || !tierWhich) continue;
			else if (tierWhich !== 'tier' || (!this.manager.config.premiumTiers.some((tier) => tier.tierId === tierId) && !getExtra)) continue;
			else if (!['guild', 'user'].includes(tierType)) throw new Error(`Invalid tier type for product ${product.id} (${tierId}): ${tierType}.`);

			const exists = tiers.find((tier) => tier.tierId === tierId);
			if (exists) continue;

			tiers.push({
				tierId,
				type: tierType as 'guild' | 'user',
				name: product.name,
				isActive: product.active,
				priceCents: monthlyPrice.unit_amount ?? 0,
				stripeProductId: product.id,
				monthlyPriceId: monthlyPrice.id,
				yearlyPriceId: yearlyPrice.id,
			});
		}

		return tiers;
	}

	private async changeActiveState(tierId: string, isActive: boolean, allProducts: Stripe.Product[], allPrices: Stripe.Price[]): Promise<boolean> {
		const tiers = await this.getStripeTiersInternal(true, allProducts, allPrices);
		const tier = tiers.find((tier) => tier.tierId === tierId);
		if (!tier) throw new Error(`Tier not found for ID ${tierId} (#1).`);
		else if (tier.isActive === isActive) return true;

		await this.stripe.products.update(tier.stripeProductId, {
			active: isActive,
		});

		await this.stripe.prices.update(tier.monthlyPriceId, {
			active: isActive,
		});

		await this.stripe.prices.update(tier.yearlyPriceId, {
			active: isActive,
		});

		return true;
	}

	private async changePrice(tierId: string, priceCents: number, currency: string, allProducts: Stripe.Product[], allPrices: Stripe.Price[]): Promise<boolean> {
		const tiers = await this.getStripeTiersInternal(true, allProducts, allPrices);
		const tier = tiers.find((tier) => tier.tierId === tierId);
		if (!tier) throw new Error(`Tier not found for ID ${tierId} (#2).`);
		else if (priceCents === tier.priceCents) return true;

		const monthlyPrice = await this.stripe.prices.retrieve(tier.monthlyPriceId).catch(() => null);
		const yearlyPrice = await this.stripe.prices.retrieve(tier.yearlyPriceId).catch(() => null);

		const newMonthlyPrice = allPrices.find((price) =>
			price.active === true &&
			price.currency === currency &&
			price.unit_amount === priceCents &&
			price.recurring?.interval === 'month' &&
			price.product === tier.stripeProductId &&
			price.metadata._internal_id === tierId &&
			price.metadata._internal_which === 'tier' &&
			price.metadata._internal_type === tier.type,
		) || await this.stripe.prices.create({
			unit_amount: priceCents,
			currency: currency ?? 'usd',
			product: tier.stripeProductId,
			active: true,
			tax_behavior: this.manager.config.options?.stripe?.includeTaxInPrice ? 'inclusive' : 'exclusive',
			recurring: {
				interval: 'month',
			},
			metadata: {
				_internal_type: tier.type,
				_internal_id: tier.tierId,
				_internal_which: 'tier',
			},
		}).catch(() => null);

		const newYearlyPrice = allPrices.find((price) =>
			price.active === true &&
			price.currency === currency &&
			price.recurring?.interval === 'year' &&
			price.unit_amount === priceCents * getYearlyMultiplier(tier.yearlyMultiplier) &&
			price.product === tier.stripeProductId &&
			price.metadata._internal_id === tierId &&
			price.metadata._internal_which === 'tier' &&
			price.metadata._internal_type === tier.type,
		) || await this.stripe.prices.create({
			unit_amount: priceCents * getYearlyMultiplier(tier.yearlyMultiplier),
			currency: currency ?? 'usd',
			product: tier.stripeProductId,
			active: true,
			tax_behavior: this.manager.config.options?.stripe?.includeTaxInPrice ? 'inclusive' : 'exclusive',
			recurring: {
				interval: 'year',
			},
			metadata: {
				_internal_type: tier.type,
				_internal_id: tier.tierId,
				_internal_which: 'tier',
			},
		}).catch(() => null);

		if (!newMonthlyPrice || !newYearlyPrice) throw new Error('Failed to create or update prices for tier.');

		await this.stripe.products.update(tier.stripeProductId, { default_price: newMonthlyPrice.id });
		if (monthlyPrice && newMonthlyPrice.id !== monthlyPrice.id) await this.stripe.prices.update(monthlyPrice.id, { active: false });
		if (yearlyPrice && newYearlyPrice.id !== yearlyPrice.id) await this.stripe.prices.update(yearlyPrice.id, { active: false });

		return true;
	}

	private async deleteTier(tierId: string, allProducts: Stripe.Product[], allPrices: Stripe.Price[]): Promise<boolean> {
		const tiers = await this.getStripeTiersInternal(true, allProducts, allPrices);
		const tier = tiers.find((tier) => tier.tierId === tierId);
		if (!tier) throw new Error(`Tier not found for ID ${tierId} (#3).`);

		await this.stripe.products.update(tier.stripeProductId, {
			active: false,
		});

		await this.stripe.prices.update(tier.monthlyPriceId, {
			active: false,
		});

		await this.stripe.prices.update(tier.yearlyPriceId, {
			active: false,
		});

		return true;
	}

	public async syncOrCreateTiers(): Promise<void> {
		const allProducts = await this.manager.stripeManager.internalGetAllProducts();
		const allPrices = await this.manager.stripeManager.internalGetAllPrices();

		const stripeTiers = await this.getStripeTiersInternal(true, allProducts, allPrices);
		const stripeTierIds = stripeTiers.map((tier) => tier.tierId);

		const missingTiers = this.manager.config.premiumTiers.filter((tier) => !stripeTierIds.includes(tier.tierId));
		const foundTiers = this.manager.config.premiumTiers.filter((tier) => stripeTierIds.includes(tier.tierId));
		const extraTiers = stripeTiers.filter((tier) => !this.manager.config.premiumTiers.some((t) => t.tierId === tier.tierId) && tier.isActive);

		await this.createMissingTiers(missingTiers, allProducts, allPrices);
		await this.updateExistingTiers(foundTiers, stripeTiers, allProducts, allPrices);
		await this.deleteExtraTiers(extraTiers, allProducts, allPrices);
	}

	private async createMissingTiers(missingTiers: PremiumTier[], allProducts: Stripe.Product[], allPrices: Stripe.Price[]): Promise<void> {
		for await (const tier of missingTiers) {
			await this.createTier(tier, allProducts, allPrices).catch(() => null);
		}
	}

	private async updateExistingTiers(foundTiers: PremiumTier[], stripeTiers: StripeTier[], allProducts: Stripe.Product[], allPrices: Stripe.Price[]): Promise<void> {
		for (const tier of foundTiers) {
			const stripeTier = stripeTiers.find((t) => t.tierId === tier.tierId);
			if (!stripeTier) continue;

			if (stripeTier.priceCents !== tier.priceCents) {
				await this.changePrice(tier.tierId, tier.priceCents, tier.currency || 'usd', allProducts, allPrices);
			}

			if (stripeTier.isActive !== tier.isActive) {
				await this.changeActiveState(tier.tierId, tier.isActive, allProducts, allPrices);
			}

			if (stripeTier.name !== tier.name) {
				await this.stripe.products.update(stripeTier.stripeProductId, {
					name: tier.name,
				});
			}

			if (stripeTier.type !== tier.type) {
				await this.stripe.products.update(stripeTier.stripeProductId, {
					metadata: {
						_internal_type: tier.type,
						_internal_id: tier.tierId,
						_internal_which: 'tier',
					},
				});
			}
		}
	}

	private async deleteExtraTiers(extraTiers: StripeTier[], allProducts: Stripe.Product[], allPrices: Stripe.Price[]): Promise<void> {
		for await (const tier of extraTiers) {
			await this.deleteTier(tier.tierId, allProducts, allPrices);
		}
	}

	public async getTiersFromItems(items: Stripe.SubscriptionItem[], stripeTiers?: StripeTier[]): Promise<StripeTier[]> {
		if (!items.length) return [];

		const tiers = stripeTiers || await this.getStripeTiersInternal();
		const tierIds = tiers.map((tier) => tier.tierId);

		const subscriptionTiers = items.filter((item) => item.price.metadata._internal_id && tierIds.includes(item.price.metadata._internal_id));
		const foundTiers = subscriptionTiers.map((item) => {
			const tier = tiers.find((tier) => tier.tierId === item.price.metadata._internal_id);
			if (!tier) return null;

			return tier;
		});

		return foundTiers.filter((tier): tier is StripeTier => Boolean(tier));
	}

	public async checkIfTierChange(newItems: Stripe.SubscriptionItem[], oldItems: Stripe.SubscriptionItem[]): Promise<{ newTierId: string; oldTierId: string; } | null> {
		const stripeTiers = await this.getStripeTiersInternal();

		const newTiers = await this.getTiersFromItems(newItems, stripeTiers);
		const oldTiers = await this.getTiersFromItems(oldItems, stripeTiers);

		const newTierIds = newTiers.map((tier) => tier.tierId);
		const oldTierIds = oldTiers.map((tier) => tier.tierId);

		const newTierId = newTierIds[0];
		const oldTierId = oldTierIds[0];

		if (!newTierId || !oldTierId) return null;
		else if (newTierId === oldTierId) return null;
		else return { newTierId, oldTierId };
	}
}

export class StripeAddons {
	constructor (private readonly manager: PremiumManager, private readonly stripe: Stripe) { }

	private async createAddon(data: Addon, allProducts: Stripe.Product[], allPrices: Stripe.Price[]): Promise<Stripe.Product> {
		if (data.priceCents <= 0) throw new Error(`Invalid price for addon ${data.addonId}: ${data.priceCents}.`);

		let product = allProducts.find((p) => p.metadata._internal_id === data.addonId && p.metadata._internal_type === data.type && p.metadata._internal_which === 'addon');

		if (!product) {
			product = await this.stripe.products.create({
				name: data.name,
				metadata: {
					_internal_type: data.type,
					_internal_id: data.addonId,
					_internal_which: 'addon',
				},
			});
		} else if (!product.active) {
			await this.stripe.products.update(product.id, { active: true });

			const productPrices = allPrices.filter((price) => price.product === product!.id).filter((price) => price.active === false);
			for await (const price of productPrices) await this.stripe.prices.update(price.id, { active: true });
		} else if (product.name !== data.name) {
			await this.stripe.products.update(product.id, { name: data.name });
		}

		const createOrUpdatePrice = async (interval: 'month' | 'year', amount: number): Promise<Stripe.Price> => {
			const existingPrice = allPrices.find((price) => price.unit_amount === amount && price.recurring?.interval === interval && price.product === product.id);

			if (existingPrice) {
				if (!existingPrice.active) await this.stripe.prices.update(existingPrice.id, { active: true });
				return existingPrice;
			}

			return await this.stripe.prices.create({
				unit_amount: amount,
				currency: data.currency ?? 'usd',
				product: product.id,
				active: data.isActive ?? true,
				tax_behavior: this.manager.config.options?.stripe?.includeTaxInPrice ? 'inclusive' : 'exclusive',
				recurring: {
					interval,
				},
				metadata: {
					_internal_type: data.type,
					_internal_id: data.addonId,
					_internal_which: 'addon',
				},
			});
		};

		const monthlyPrice = await createOrUpdatePrice('month', data.priceCents).catch(() => null);
		const yearlyPrice = await createOrUpdatePrice('year', data.priceCents * getYearlyMultiplier(data.yearlyMultiplier)).catch(() => null);
		if (!monthlyPrice || !yearlyPrice) throw new Error('Failed to create or update prices for addon.');

		await this.stripe.products.update(product.id, { default_price: monthlyPrice.id });
		return product;
	}

	public async getStripeAddons(): Promise<StripeAddon[]> {
		return this.getStripeAddonsInternal();
	}

	private async getStripeAddonsInternal(getExtra?: boolean, internalAllProducts?: Stripe.Product[], internalAllPrices?: Stripe.Price[]): Promise<StripeAddon[]> {
		const allProducts = internalAllProducts || await this.manager.stripeManager.internalGetAllProducts();
		const allPrices = internalAllPrices || await this.manager.stripeManager.internalGetAllPrices();

		const addons: StripeAddon[] = [];

		for await (const product of allProducts) {
			const monthlyPrice = allPrices.find((price) => price.recurring?.interval === 'month' && price.product === product.id);
			const yearlyPrice = allPrices.find((price) => price.recurring?.interval === 'year' && price.product === product.id);
			if (!monthlyPrice || !yearlyPrice) continue;

			const addonId = product.metadata._internal_id;
			const addonType = product.metadata._internal_type;
			const addonWhich = product.metadata._internal_which;

			if (!addonId || !addonType || !addonWhich) continue;
			else if (addonWhich !== 'addon' || (!this.manager.config.addons.some((addon) => addon.addonId === addonId) && !getExtra)) continue;
			else if (!['guild', 'user'].includes(addonType)) throw new Error(`Invalid addon type for product ${product.id} (${addonId}): ${addonType}`);

			const exists = addons.find((addon) => addon.addonId === addonId);
			if (exists) continue;

			addons.push({
				addonId,
				type: addonType as 'guild' | 'user',
				name: product.name,
				isActive: product.active,
				priceCents: monthlyPrice.unit_amount ?? 0,
				stripeProductId: product.id,
				monthlyPriceId: monthlyPrice.id,
				yearlyPriceId: yearlyPrice.id,
			});
		}

		return addons;
	}

	private async changeActiveState(addonId: string, isActive: boolean, allProducts: Stripe.Product[]): Promise<boolean> {
		const addons = await this.getStripeAddonsInternal(true, allProducts);
		const addon = addons.find((addon) => addon.addonId === addonId);
		if (!addon) throw new Error(`Addon not found for ID ${addonId} (#1).`);

		await this.stripe.products.update(addon.stripeProductId, {
			active: isActive,
		});

		await this.stripe.prices.update(addon.monthlyPriceId, {
			active: isActive,
		});

		await this.stripe.prices.update(addon.yearlyPriceId, {
			active: isActive,
		});

		return true;
	}

	private async changePrice(addonId: string, priceCents: number, currency: string, allProducts: Stripe.Product[], allPrices: Stripe.Price[]): Promise<boolean> {
		const addons = await this.getStripeAddonsInternal(true, allProducts, allPrices);
		const addon = addons.find((addon) => addon.addonId === addonId);
		if (!addon) throw new Error(`Addon not found for ID ${addonId} (#2).`);
		else if (priceCents === addon.priceCents) return true;

		const monthlyPrice = await this.stripe.prices.retrieve(addon.monthlyPriceId).catch(() => null);
		const yearlyPrice = await this.stripe.prices.retrieve(addon.yearlyPriceId).catch(() => null);

		const newMonthlyPrice = allPrices.find((price) =>
			price.active === true &&
			price.currency === currency &&
			price.unit_amount === priceCents &&
			price.recurring?.interval === 'month' &&
			price.product === addon.stripeProductId &&
			price.metadata._internal_id === addonId &&
			price.metadata._internal_which === 'addon' &&
			price.metadata._internal_type === addon.type,
		) || await this.stripe.prices.create({
			unit_amount: priceCents,
			currency: currency ?? 'usd',
			product: addon.stripeProductId,
			active: true,
			tax_behavior: this.manager.config.options?.stripe?.includeTaxInPrice ? 'inclusive' : 'exclusive',
			recurring: {
				interval: 'month',
			},
			metadata: {
				_internal_type: addon.type,
				_internal_id: addon.addonId,
				_internal_which: 'addon',
			},
		}).catch(() => null);

		const newYearlyPrice = allPrices.find((price) =>
			price.active === true &&
			price.currency === currency &&
			price.unit_amount === priceCents * getYearlyMultiplier(addon.yearlyMultiplier) &&
			price.recurring?.interval === 'year' &&
			price.product === addon.stripeProductId &&
			price.metadata._internal_id === addonId &&
			price.metadata._internal_which === 'addon' &&
			price.metadata._internal_type === addon.type,
		) || await this.stripe.prices.create({
			unit_amount: priceCents * getYearlyMultiplier(addon.yearlyMultiplier),
			currency: currency ?? 'usd',
			product: addon.stripeProductId,
			active: true,
			tax_behavior: this.manager.config.options?.stripe?.includeTaxInPrice ? 'inclusive' : 'exclusive',
			recurring: {
				interval: 'year',
			},
			metadata: {
				_internal_type: addon.type,
				_internal_id: addon.addonId,
				_internal_which: 'addon',
			},
		}).catch(() => null);

		if (!newMonthlyPrice || !newYearlyPrice) throw new Error('Failed to create or update prices for addon.');

		await this.stripe.products.update(addon.stripeProductId, { default_price: newMonthlyPrice.id });
		if (monthlyPrice && newMonthlyPrice.id !== monthlyPrice.id) await this.stripe.prices.update(monthlyPrice.id, { active: false });
		if (yearlyPrice && newYearlyPrice.id !== yearlyPrice.id) await this.stripe.prices.update(yearlyPrice.id, { active: false });

		return true;
	}

	private async deleteAddon(addonId: string, allProducts: Stripe.Product[], allPrices: Stripe.Price[]): Promise<boolean> {
		const addons = await this.getStripeAddonsInternal(true, allProducts, allPrices);
		const addon = addons.find((addon) => addon.addonId === addonId);
		if (!addon) throw new Error(`Addon not found for ID ${addonId} (#3).`);

		await this.stripe.products.update(addon.stripeProductId, {
			active: false,
		});

		await this.stripe.prices.update(addon.monthlyPriceId, {
			active: false,
		});

		await this.stripe.prices.update(addon.yearlyPriceId, {
			active: false,
		});

		return true;
	}

	public async syncOrCreateAddons(): Promise<void> {
		const allProducts = await this.manager.stripeManager.internalGetAllProducts();
		const allPrices = await this.manager.stripeManager.internalGetAllPrices();

		const stripeAddons = await this.getStripeAddonsInternal(true, allProducts, allPrices);
		const stripeAddonIds = stripeAddons.map((addon) => addon.addonId);

		const missingAddons = this.manager.config.addons.filter((addon) => !stripeAddonIds.includes(addon.addonId));
		const foundAddons = this.manager.config.addons.filter((addon) => stripeAddonIds.includes(addon.addonId));
		const extraAddons = stripeAddons.filter((addon) => !this.manager.config.addons.some((a) => a.addonId === addon.addonId) && addon.isActive);

		await this.createMissingAddons(missingAddons, allProducts, allPrices);
		await this.updateExistingAddons(foundAddons, stripeAddons, allProducts, allPrices);
		await this.deleteExtraAddons(extraAddons, allProducts, allPrices);
	}

	private async createMissingAddons(missingAddons: Addon[], allProducts: Stripe.Product[], allPrices: Stripe.Price[]): Promise<void> {
		for await (const addon of missingAddons) {
			await this.createAddon(addon, allProducts, allPrices).catch(() => null);
		}
	}

	private async updateExistingAddons(foundAddons: Addon[], stripeAddons: StripeAddon[], allProducts: Stripe.Product[], allPrices: Stripe.Price[]): Promise<void> {
		for (const addon of foundAddons) {
			const stripeAddon = stripeAddons.find((a) => a.addonId === addon.addonId);
			if (!stripeAddon) continue;

			if (stripeAddon.priceCents !== addon.priceCents) {
				await this.changePrice(addon.addonId, addon.priceCents, addon.currency || 'usd', allProducts, allPrices);
			}

			if (stripeAddon.isActive !== addon.isActive) {
				await this.changeActiveState(addon.addonId, addon.isActive, allProducts);
			}

			if (stripeAddon.name !== addon.name) {
				await this.stripe.products.update(stripeAddon.stripeProductId, {
					name: addon.name,
				});
			}

			if (stripeAddon.type !== addon.type) {
				await this.stripe.products.update(stripeAddon.stripeProductId, {
					metadata: {
						_internal_type: addon.type,
						_internal_id: addon.addonId,
						_internal_which: 'addon',
					},
				});
			}
		}
	}

	private async deleteExtraAddons(extraAddons: StripeAddon[], allProducts: Stripe.Product[], allPrices: Stripe.Price[]): Promise<void> {
		for await (const addon of extraAddons) {
			await this.deleteAddon(addon.addonId, allProducts, allPrices).catch(() => null);
		}
	}

	public async getAddonsFromItems(items: Stripe.SubscriptionItem[], stripeAddons?: StripeAddon[]): Promise<WithQuantity<StripeAddon>[]> {
		if (!items.length) return [];

		const addons = stripeAddons || await this.getStripeAddons();
		const addonIds = addons.map((addon) => addon.addonId);

		const subscriptionAddons = items.filter((item) => item.price.metadata._internal_id && addonIds.includes(item.price.metadata._internal_id));
		const foundAddons = subscriptionAddons.map((item) => {
			const addon = addons.find((addon) => addon.addonId === item.price.metadata._internal_id);
			if (!addon) return null;

			return {
				...addon,
				quantity: item.quantity,
			};
		});

		return foundAddons.filter((addon): addon is WithQuantity<StripeAddon> => Boolean(addon));
	}

	public async checkIfAddonChange(newItems: Stripe.SubscriptionItem[], oldItems: Stripe.SubscriptionItem[], stripeAddons?: StripeAddon[]): Promise<Record<'currentAddons' | 'previousAddons' | 'changedQuantity', WithQuantity<StripeAddon>[]> | null> {
		if (!stripeAddons?.length) stripeAddons = await this.getStripeAddons();

		const currentAddons = await this.getAddonsFromItems(newItems, stripeAddons);
		const previousAddons = await this.getAddonsFromItems(oldItems.length ? oldItems : newItems, stripeAddons);
		const changedQuantity = currentAddons.filter((newAddon) => {
			const oldAddon = previousAddons.find((addon) => addon.addonId === newAddon.addonId);
			if (!oldAddon) return false;

			else if (oldAddon.quantity !== newAddon.quantity) return true;
			else return false;
		});

		const hasDifferences = currentAddons.some((newAddon) => {
			const oldAddon = previousAddons.find((addon) => addon.addonId === newAddon.addonId);
			if (!oldAddon) return true;
			else if (oldAddon.quantity !== newAddon.quantity) return true;
			else return false;
		});

		if (!hasDifferences) return null;
		else if (!currentAddons.length && !previousAddons.length && !changedQuantity.length) return null;
		else return { currentAddons, previousAddons, changedQuantity };
	}
}

export class StripeSubscriptions {
	constructor (private readonly manager: PremiumManager, private readonly stripe: Stripe, private readonly stripeManager: StripeManager) { }

	public async getAllSubscriptions(options?: Stripe.SubscriptionListParams): Promise<Stripe.Subscription[]> {
		const subscriptions = await this.internalGetAllSubscriptions(options);
		if (!subscriptions) return [];

		return subscriptions;
	}

	private async internalGetAllSubscriptions(options?: Stripe.SubscriptionListParams, acc: Stripe.Subscription[] = [], startingAfter?: string): Promise<Stripe.Subscription[]> {
		const subs = await this.stripe.subscriptions.list({ ...options, limit: 100, starting_after: startingAfter });
		acc.push(...subs.data);

		if (subs.has_more) return this.internalGetAllSubscriptions(options, acc, subs.data[subs.data.length - 1]?.id);
		else return acc;
	}

	public async getSubscriptionsFor(options: CustomerQueryData): Promise<{ user: Stripe.Subscription | null; guild: Stripe.Subscription[]; }> {
		const customer = await this.stripeManager.customers.getCustomer(options);
		if (!customer) throw new Error('Failed to get customer.');

		const subscriptions = await this.internalGetAllSubscriptions({ customer: customer.id });
		if (!subscriptions) return { user: null, guild: [] };

		return {
			user: subscriptions.find((sub) => sub.metadata.isUserSub) || null,
			guild: subscriptions.filter((sub) => !sub.metadata.isUserSub) || [],
		};
	}

	public async getUserSubscription(options: CustomerQueryData): Promise<Stripe.Subscription | null> {
		const subscriptions = await this.getSubscriptionsFor(options);
		return subscriptions.user;
	}

	public async getGuildSubscription({ guildId }: { guildId: string; }): Promise<Stripe.Subscription | null> {
		const subscriptions = await this.internalGetAllSubscriptions();
		return subscriptions.find((sub) => sub.metadata.guildId === guildId) || null;
	}

	public async cancelSubscription(subscriptionId: string, immediately = false): Promise<boolean> {
		const subscription = await this.stripe.subscriptions.retrieve(subscriptionId).catch(() => null);
		if (!subscription) throw new Error(`Subscription not found for ID ${subscriptionId} (#1).`);

		if (immediately) await this.stripe.subscriptions.cancel(subscriptionId, { invoice_now: true });
		else await this.stripe.subscriptions.update(subscriptionId, { cancel_at_period_end: true });

		return true;
	}

	public async changeSubscriptionGuild(subscriptionId: string, newGuildId: string, guildName?: string, emitEvents = true): Promise<boolean> {
		const subscription = await this.stripe.subscriptions.retrieve(subscriptionId).catch(() => null);
		if (!subscription) throw new Error(`Subscription not found for ID ${subscriptionId} (#4).`);
		else if (!subscription.metadata.userId) throw new Error(`Missing user ID in subscription ${subscriptionId}.`);
		else if (subscription.metadata.isUserSub === 'true') throw new Error('Cannot change guild for user subscriptions.');
		else if (!subscription.metadata.guildId) throw new Error(`Missing guild ID in subscription ${subscriptionId} (#3).`);
		else if (subscription.metadata.guildId === newGuildId) return true;

		const existingGuildSub = await this.getGuildSubscription({ guildId: newGuildId });
		if (existingGuildSub) throw new Error('The new guild already has a subscription.');

		const oldGuildId = subscription.metadata.guildId;

		await this.stripe.subscriptions.update(subscriptionId, {
			description: `Subscription for ${guildName || `guild ${newGuildId}`}.`,
			metadata: {
				...subscription.metadata,
				guildId: newGuildId,
			},
		});

		if (emitEvents) {
			const tierData = this.manager.config.premiumTiers.find((tier) => tier.tierId === subscription.metadata.tierId);
			if (!tierData) throw new Error(`Tier not found for ID ${subscription.metadata.tierId} (#6).`);

			const latestInvoice = typeof subscription.latest_invoice === 'string' ? await this.stripe.invoices.retrieve(subscription.latest_invoice) : subscription.latest_invoice;
			if (!latestInvoice) throw new Error(`Latest invoice not found for subscription ${subscriptionId} (#5).`);

			const addons = await this.manager.stripeManager.addons.getAddonsFromItems(subscription.items.data) ?? [];
			const isAnnual = subscription.metadata.isAnnual === 'true';

			this.manager.emit('subscriptionDelete', {
				type: 'guild',
				tier: tierData,

				userId: subscription.metadata.userId,
				guildId: oldGuildId,

				isAnnual,
				addons,

				raw: { subscription },
			});

			this.manager.emit('subscriptionCreate', {
				type: 'guild',
				tier: tierData,

				userId: subscription.metadata.userId,
				guildId: newGuildId,

				isAnnual,
				addons,

				raw: { subscription, invoice: latestInvoice },
			});
		}

		return true;
	}

	public async changeSubscriptionUser(subscriptionId: string, newUserId: string, emitEvents = true): Promise<boolean> {
		const subscription = await this.stripe.subscriptions.retrieve(subscriptionId).catch(() => null);
		if (!subscription) throw new Error(`Subscription not found for ID ${subscriptionId} (#2).`);
		else if (subscription.metadata.isUserSub !== 'true') throw new Error('Cannot change user for guild subscriptions.');
		else if (!subscription.metadata.userId) throw new Error(`Missing user ID in subscription ${subscriptionId} (#5).`);
		else if (subscription.metadata.userId === newUserId) return true;

		const existingUserSub = await this.getUserSubscription({ customerId: typeof subscription.customer === 'string' ? subscription.customer : subscription.customer.id });
		if (existingUserSub) throw new Error('The new user already has a user subscription.');

		const oldUserId = subscription.metadata.userId;

		await this.stripe.subscriptions.update(subscriptionId, {
			metadata: {
				...subscription.metadata,
				userId: newUserId,
			},
		});

		if (emitEvents) {
			const tierData = this.manager.config.premiumTiers.find((tier) => tier.tierId === subscription.metadata.tierId);
			if (!tierData) throw new Error(`Tier not found for ID ${subscription.metadata.tierId} (#7).`);

			const latestInvoice = typeof subscription.latest_invoice === 'string' ? await this.stripe.invoices.retrieve(subscription.latest_invoice) : subscription.latest_invoice;
			if (!latestInvoice) throw new Error(`Latest invoice not found for subscription ${subscriptionId} (#6).`);

			const addons = await this.manager.stripeManager.addons.getAddonsFromItems(subscription.items.data) ?? [];
			const isAnnual = subscription.metadata.isAnnual === 'true';

			this.manager.emit('subscriptionDelete', {
				type: 'user',
				tier: tierData,

				guildId: null,
				userId: oldUserId,

				isAnnual,
				addons,

				raw: { subscription },
			});

			this.manager.emit('subscriptionCreate', {
				type: 'user',
				tier: tierData,

				guildId: null,
				userId: newUserId,

				isAnnual,
				addons,

				raw: { subscription, invoice: latestInvoice },
			});
		}

		return true;
	}

	public async refundCharge(chargeId: string, isFraud = false): Promise<boolean> {
		const charge = await this.stripe.charges.retrieve(chargeId).catch(() => null);
		if (!charge) throw new Error(`Charge not found for ID ${chargeId}.`);

		await this.stripe.refunds.create({
			charge: charge.id,
			reason: isFraud ? 'fraudulent' : 'requested_by_customer',
		});

		return true;
	}

	public async createCheckoutSession(data: SubscriptionCreateInputData): Promise<Stripe.Checkout.Session> {
		const stripeTiers = await this.stripeManager.tiers.getStripeTiers();
		if (!stripeTiers) throw new Error('Failed to get tiers.');

		const tierData = stripeTiers.find((tier) => tier.tierId === data.tierId);
		if (!tierData) throw new Error(`Tier not found for ID ${data.tierId} (#4).`);
		else if (tierData.priceCents === 0) throw new Error('Tiers with a price of 0 cannot be subscribed to.');
		else if (!tierData.isActive) throw new Error('Tier is not active.');
		else if (data.addons?.some((addon) => addon.quantity < 1)) throw new Error('Addon quantities must be at least 1.');

		const joinIfExists = (s1: string | null, s2: string) => s1 ? `${s1}${s2}` : `https://example.com/checkout${s2}`;

		switch (tierData.type) {
			case 'user': {
				const stripeAddons = data.addons?.length ? await this.stripeManager.addons.getStripeAddons() : [];

				const isAnyAddonNotUser = stripeAddons?.some((addon) => addon.type !== 'user');
				if (isAnyAddonNotUser) throw new Error('User subscriptions cannot have guild addons.');
				else if (data.guildId) throw new Error('User subscriptions cannot be created for guilds.');

				const customer = await this.stripeManager.customers.getOrCreateCustomer(data.customer);
				if (!customer) throw new Error('Failed to create or get customer.');
				else if (!customer.metadata.userId) throw new Error('Missing user ID in customer.');

				const userSub = await this.getUserSubscription({ customerId: customer.id });
				if (userSub) throw new Error('User already has a user subscription.');

				const daysForTrial = data.trialEndsAt ? Math.round((data.trialEndsAt.getTime() - Date.now()) / 86400000) : 0;
				const lineItems: Stripe.Checkout.SessionCreateParams.LineItem[] = [{
					price: data.isAnnual ? tierData.yearlyPriceId : tierData.monthlyPriceId,
					quantity: 1,
				}];

				for (const addon of data.addons || []) {
					const addonData = stripeAddons.find((a) => a.addonId === addon.addonId);
					if (!addonData) throw new Error(`Addon not found for ID ${addon.addonId} (#4).`);
					else if (addonData.priceCents === 0) throw new Error(`Addons with a price of 0 cannot be subscribed to (${addon.addonId}) (#1).`);

					lineItems.push({
						price: data.isAnnual ? addonData.yearlyPriceId : addonData.monthlyPriceId,
						quantity: addon.quantity,
					});
				}

				const session = await this.stripe.checkout.sessions.create({
					customer: customer.id,
					mode: 'subscription',
					client_reference_id: customer.metadata.userId,
					allow_promotion_codes: true,
					line_items: lineItems,
					success_url: joinIfExists(this.manager.config.options?.stripe?.redirectUrl || null, `?success=true&userId=${customer.metadata.userId}`),
					cancel_url: joinIfExists(this.manager.config.options?.stripe?.redirectUrl || null, `?success=false&userId=${customer.metadata.userId}`),
					subscription_data: {
						trial_period_days: daysForTrial || undefined,
						trial_settings: daysForTrial ? {
							end_behavior: {
								missing_payment_method: 'cancel',
							},
						} : undefined,
						metadata: {
							...(data.metadata ?? {}),
							tierId: tierData.tierId,
							userId: customer.metadata.userId,
							isUserSub: 'true',
							isAnnual: data.isAnnual ? 'true' : 'false',
						},
					},
					metadata: data.metadata ?? {},
					saved_payment_method_options: {
						payment_method_save: 'enabled',
					},
					payment_method_options: {
						card: {
							request_three_d_secure: 'any',
						},
					},
				});

				return session;
			}
			case 'guild': {
				const stripeAddons = data.addons?.length ? await this.stripeManager.addons.getStripeAddons() : [];

				const isAnyAddonNotGuild = stripeAddons?.some((addon) => addon.type !== 'guild');
				if (isAnyAddonNotGuild) throw new Error('Guild subscriptions cannot have user addons.');
				else if (!data.guildId) throw new Error('Guild subscriptions must be created for guilds.');

				const customer = await this.stripeManager.customers.getOrCreateCustomer(data.customer);
				if (!customer) throw new Error('Failed to create or get customer.');
				else if (!customer.metadata.userId) throw new Error('Missing user ID in customer.');

				const guildSub = await this.getGuildSubscription({ guildId: data.guildId });
				if (guildSub) throw new Error('Guild already has a guild subscription.');

				const daysForTrial = data.trialEndsAt ? Math.round((data.trialEndsAt.getTime() - Date.now()) / 86400000) : 0;
				const lineItems: Stripe.Checkout.SessionCreateParams.LineItem[] = [{
					price: data.isAnnual ? tierData.yearlyPriceId : tierData.monthlyPriceId,
					quantity: 1,
				}];

				for (const addon of data.addons || []) {
					const addonData = stripeAddons.find((a) => a.addonId === addon.addonId);
					if (!addonData) throw new Error(`Addon not found for ID ${addon.addonId} (#5).`);
					else if (addonData.priceCents === 0) throw new Error(`Addons with a price of 0 cannot be subscribed to (${addon.addonId}) (#2).`);

					lineItems.push({
						price: data.isAnnual ? addonData.yearlyPriceId : addonData.monthlyPriceId,
						quantity: addon.quantity,
					});
				}

				const session = await this.stripe.checkout.sessions.create({
					customer: customer.id,
					mode: 'subscription',
					client_reference_id: customer.metadata.userId,
					allow_promotion_codes: true,
					line_items: lineItems,
					success_url: joinIfExists(this.manager.config.options?.stripe?.redirectUrl || null, `?success=true&userId=${customer.metadata.userId}&guildId=${data.guildId}`),
					cancel_url: joinIfExists(this.manager.config.options?.stripe?.redirectUrl || null, `?success=false&userId=${customer.metadata.userId}&guildId=${data.guildId}`),
					subscription_data: {
						description: `Subscription for ${data.guildName || `guild ${data.guildId}`}.`,
						trial_period_days: daysForTrial || undefined,
						trial_settings: daysForTrial ? {
							end_behavior: {
								missing_payment_method: 'cancel',
							},
						} : undefined,
						metadata: {
							...(data.metadata ?? {}),
							tierId: tierData.tierId,
							userId: customer.metadata.userId,
							guildId: data.guildId,
							isAnnual: data.isAnnual ? 'true' : 'false',
						},
					},
					metadata: data.metadata ?? {},
					saved_payment_method_options: {
						payment_method_save: 'enabled',
					},
				});

				return session;
			}
		}
	}

	public async changeSubscriptionTier(subscriptionId: string, newTierId: string, options?: Partial<ChargeOptions>): Promise<boolean> {
		const subscription = await this.stripe.subscriptions.retrieve(subscriptionId).catch(() => null);
		if (!subscription) throw new Error(`Subscription not found for ID ${subscriptionId} (#2).`);
		else if (!subscription.metadata.userId) throw new Error(`Missing user ID in subscription ${subscriptionId}.`);
		else if (!subscription.metadata.isUserSub && !subscription.metadata.guildId) throw new Error(`Missing guild ID in subscription ${subscriptionId} (#1).`);
		else if (subscription.metadata.tierId === newTierId) return true;

		const customerId = typeof subscription.customer === 'string' ? subscription.customer : subscription.customer.id;
		if (!customerId) throw new Error(`Missing customer ID in subscription ${subscriptionId} (#1).`);

		const stripeTiers = await this.stripeManager.tiers.getStripeTiers();
		if (!stripeTiers.length) throw new Error('Tiers not found.');

		const newTierPrice = stripeTiers.find((tier) => tier.tierId === newTierId);
		if (!newTierPrice) throw new Error(`Tier not found for ID ${newTierId} (#5).`);
		else if (newTierPrice.priceCents === 0) throw new Error('Tiers with a price of 0 cannot be subscribed to.');
		else if (!newTierPrice.isActive) throw new Error('Tier is not active.');

		const subscriptionType = subscription.metadata.isUserSub === 'true' ? 'user' : 'guild';
		if (newTierPrice.type !== subscriptionType) throw new Error(`${subscriptionType === 'user' ? 'User' : 'Guild'} subscriptions cannot have tiers for the other type.`);

		const itemThatIsMainTier = subscription.items.data.find((item) => item.price.metadata._internal_id === subscription.metadata.tierId);
		if (!itemThatIsMainTier) throw new Error(`Main tier not found for subscription ${subscriptionId} (#1).`);

		const isAnnual = subscription.metadata.isAnnual === 'true';
		const newItems: Stripe.SubscriptionUpdateParams.Item[] = [{
			id: itemThatIsMainTier.id,
			price: isAnnual ? newTierPrice.yearlyPriceId : newTierPrice.monthlyPriceId,
			quantity: 1,
		}];

		for (const item of subscription.items.data) {
			if (item.id === itemThatIsMainTier.id) continue;
			else newItems.push({ id: item.id });
		}

		const chargeType = options?.chargeType || 'immediate';
		let proration_behavior: 'create_prorations' | 'none';

		if (chargeType === 'immediate') proration_behavior = 'create_prorations';
		else if (chargeType === 'endOfPeriod') proration_behavior = 'none';
		else proration_behavior = 'none';

		this.manager.emit('debug', `Updating subscription ${subscriptionId} with tier ${newTierId} and proration behavior ${proration_behavior}.`);

		await this.stripe.subscriptions.update(subscriptionId, {
			proration_behavior,
			items: newItems,
			metadata: {
				...subscription.metadata,
				tierId: newTierId,
			},
		});

		if (chargeType === 'immediate') {
			const invoice = await this.stripe.invoices.create({
				customer: customerId,
				subscription: subscriptionId,
				auto_advance: true,
				default_payment_method: typeof subscription.default_payment_method === 'string' ? subscription.default_payment_method : subscription.default_payment_method?.id,
				collection_method: 'charge_automatically',
			});

			const finalizedInvoice = await this.stripe.invoices.finalizeInvoice(invoice.id);

			if (finalizedInvoice.total < 0) {
				this.manager.emit('debug', `Subscription ${subscriptionId} has a negative total of ${finalizedInvoice.total}, and user was credited that amount.`);
				await this.stripe.customers.update(customerId, {
					balance: ((await this.stripeManager.customers.getCustomer({ customerId }))?.balance || 0) + Math.abs(finalizedInvoice.total),
				});
			} else if (finalizedInvoice.status === 'open') {
				this.manager.emit('debug', `Subscription ${subscriptionId} has a total of ${finalizedInvoice.total}, and user was charged that amount.`);
				await this.stripe.invoices.pay(invoice.id);
			}
		} else if (chargeType === 'sendInvoice') {
			const invoice = await this.stripe.invoices.create({
				customer: customerId,
				subscription: subscriptionId,
				auto_advance: true,
				collection_method: 'send_invoice',
				days_until_due: options?.dueDays || this.manager.config.options?.stripe?.defaultDueDays || 7,
			});

			await this.stripe.invoices.finalizeInvoice(invoice.id);
			this.manager.emit('debug', `Subscription ${subscriptionId} has a total of ${invoice.total}, and an invoice was sent to the user.`);
		}

		return true;
	}

	public async changeSubscriptionAddons(subscriptionId: string, newAddons: WithQuantity<Pick<Addon, 'addonId'>>[], options?: Partial<ChargeOptions>): Promise<boolean> {
		const subscription = await this.stripe.subscriptions.retrieve(subscriptionId).catch(() => null);
		if (!subscription) throw new Error(`Subscription not found for ID ${subscriptionId} (#3).`);
		else if (!subscription.metadata.userId) throw new Error(`Missing user ID in subscription ${subscriptionId}.`);
		else if (!subscription.metadata.isUserSub && !subscription.metadata.guildId) throw new Error(`Missing guild ID in subscription ${subscriptionId} (#2).`);

		const customerId = typeof subscription.customer === 'string' ? subscription.customer : subscription.customer.id;
		if (!customerId) throw new Error(`Missing customer ID in subscription ${subscriptionId} (#2).`);

		const stripeAddons = await this.stripeManager.addons.getStripeAddons();
		if (!stripeAddons.length) throw new Error('Addons not found.');

		const itemThatIsMainTier = subscription.items.data.find((item) => item.price.metadata._internal_id === subscription.metadata.tierId);
		if (!itemThatIsMainTier) throw new Error(`Main tier not found for subscription ${subscriptionId} (#2).`);

		const newSelectedAddons = stripeAddons.filter((addon) => newAddons.some((newAddon) => newAddon.addonId === addon.addonId));
		if (newSelectedAddons.length !== newAddons.length) throw new Error('Invalid addon IDs provided.');
		else if (newSelectedAddons.some((addon) => addon.priceCents === 0)) throw new Error('Addons with a price of 0 cannot be subscribed to.');
		else if (newSelectedAddons.some((addon) => !addon.isActive)) throw new Error('Addons must be active to be subscribed to.');

		const subscriptionType = subscription.metadata.isUserSub === 'true' ? 'user' : 'guild';
		const isAnyAddonNotCorrectType = newSelectedAddons.some((addon) => addon.type !== subscriptionType);
		if (isAnyAddonNotCorrectType) throw new Error(`${subscriptionType === 'user' ? 'User' : 'Guild'} subscriptions cannot have addons for the other type.`);

		const currentAddonItems = subscription.items.data.filter((item) => item.price.metadata._internal_id !== subscription.metadata.tierId);
		const isUnchanged = currentAddonItems.length === newAddons.length && newAddons.every((newAddon) => {
			const currentAddonItem = currentAddonItems.find((item) => item.price.metadata._internal_id === newAddon.addonId);
			return currentAddonItem && currentAddonItem.quantity === newAddon.quantity;
		});
		if (isUnchanged) return true;

		const newItems: Stripe.SubscriptionUpdateParams.Item[] = [{ id: itemThatIsMainTier.id, price: itemThatIsMainTier.price.id, quantity: 1 }];
		const isAnnual = subscription.metadata.isAnnual === 'true';

		for (const addon of newAddons) {
			const addonData = stripeAddons.find((a) => a.addonId === addon.addonId);
			if (!addonData) throw new Error(`Addon not found for ID ${addon.addonId} (#6).`);

			const existingItem = subscription.items.data.find((item) => item.price.metadata._internal_id === addon.addonId);
			if (existingItem) {
				newItems.push({
					id: existingItem.id,
					price: existingItem.price.id,
					quantity: addon.quantity,
				});
			} else {
				newItems.push({
					price: isAnnual ? addonData.yearlyPriceId : addonData.monthlyPriceId,
					quantity: addon.quantity,
				});
			}
		}

		const deletedAddonItems = currentAddonItems.filter((item) => !newItems.some((newItem) => newItem.id === item.id));
		for (const item of deletedAddonItems) {
			newItems.push({ id: item.id, deleted: true });
		}

		this.manager.emit('debug', `Updating subscription ${subscriptionId} with addons: ${newItems.map((item) => item.price).join(', ')}.`);

		const chargeType = options?.chargeType || 'immediate';
		let proration_behavior: 'create_prorations' | 'none';

		if (chargeType === 'immediate') proration_behavior = 'create_prorations';
		else if (chargeType === 'endOfPeriod') proration_behavior = 'none';
		else proration_behavior = 'none';

		await this.stripe.subscriptions.update(subscriptionId, {
			proration_behavior,
			items: newItems,
		});

		if (chargeType === 'immediate') {
			const invoice = await this.stripe.invoices.create({
				customer: customerId,
				subscription: subscriptionId,
				auto_advance: true,
				default_payment_method: typeof subscription.default_payment_method === 'string' ? subscription.default_payment_method : subscription.default_payment_method?.id,
				collection_method: 'charge_automatically',
			});

			const finalizedInvoice = await this.stripe.invoices.finalizeInvoice(invoice.id);

			if (finalizedInvoice.total < 0) {
				this.manager.emit('debug', `Subscription ${subscriptionId} has a negative total of ${finalizedInvoice.total}, and user was credited that amount.`);
				await this.stripe.customers.update(customerId, {
					balance: ((await this.stripeManager.customers.getCustomer({ customerId }))?.balance || 0) + Math.abs(finalizedInvoice.total),
				});
			} else if (finalizedInvoice.status === 'open') {
				this.manager.emit('debug', `Subscription ${subscriptionId} has a total of ${finalizedInvoice.total}, and user was charged that amount.`);
				await this.stripe.invoices.pay(invoice.id);
			}
		} else if (chargeType === 'sendInvoice') {
			const invoice = await this.stripe.invoices.create({
				customer: customerId,
				subscription: subscriptionId,
				auto_advance: true,
				collection_method: 'send_invoice',
				days_until_due: options?.dueDays || this.manager.config.options?.stripe?.defaultDueDays || 7,
			});

			await this.stripe.invoices.finalizeInvoice(invoice.id);
			this.manager.emit('debug', `Subscription ${subscriptionId} has a total of ${invoice.total}, and an invoice was sent to the user.`);
		}

		return true;
	}

	public getAccumulatedSubscriptionCents(subscriptionItems: Stripe.SubscriptionItem[]): number {
		return subscriptionItems.reduce((acc, item) => acc + (item.price.unit_amount || 0) * (item.quantity || 1), 0) || 0;
	}
}

export class StripeCustomers {
	constructor (private readonly manager: PremiumManager, private readonly stripe: Stripe) { }

	public async getAllCustomers(options?: Stripe.CustomerListParams): Promise<Stripe.Customer[]> {
		const customers = await this.internalGetAllCustomers(options);
		if (!customers) return [];

		return customers;
	}

	private async internalGetAllCustomers(options?: Stripe.CustomerListParams, acc: Stripe.Customer[] = [], startingAfter?: string): Promise<Stripe.Customer[]> {
		const customers = await this.stripe.customers.list({ ...options, limit: 100, starting_after: startingAfter });
		acc.push(...customers.data);

		if (customers.has_more) return this.internalGetAllCustomers(options, acc, customers.data[customers.data.length - 1]?.id);
		else return acc;
	}

	public async createCustomer(data: CustomerCreateData): Promise<Stripe.Customer> {
		const check = await this.getCustomer(data);
		if (check) return check;

		return await this.stripe.customers.create({
			name: data.email,
			email: data.email,
			metadata: {
				userId: data.userId,
			},
		});
	}

	public async getCustomer(data: CustomerQueryData): Promise<Stripe.Customer | null> {
		let customer: Stripe.Customer | Stripe.DeletedCustomer | null = null;

		if ('customerId' in data) customer = await this.stripe.customers.retrieve(data.customerId).catch(() => null) || null;
		else if ('email' in data && 'userId' in data) {
			const customers = await this.internalGetAllCustomers({ email: data.email });
			customer = customers?.find((c) => c.metadata.userId === data.userId) || null;
		}

		if (customer?.deleted) return null;
		return customer;
	}

	public async getOrCreateCustomer(data: CustomerCreateData): Promise<Stripe.Customer | null> {
		const customer = await this.getCustomer(data);
		if (customer) return customer;
		else return await this.createCustomer(data);
	}

	public async updateCustomer(data: CustomerQueryData, toUpdate: CustomerUpdateData): Promise<Stripe.Customer> {
		const customer = await this.getCustomer(data);
		if (!customer) throw new Error('Customer not found.');

		const userId = toUpdate.newUserId || customer.metadata.userId;
		if (!userId) throw new Error('Missing user ID.');

		const newCustomer = await this.stripe?.customers.update(customer.id, {
			email: toUpdate.newEmail || customer.email || undefined,
			name: toUpdate.newEmail || customer.email || undefined,
			metadata: { userId: userId },
		});

		if (!newCustomer) throw new Error('Failed to update customer.');

		if (userId !== customer.metadata.userId) {
			const subscriptions = await this.stripe?.subscriptions.list({ customer: customer.id });
			if (subscriptions) {
				for (const sub of subscriptions.data) {
					await this.stripe?.subscriptions.update(sub.id, {
						metadata: {
							...sub.metadata,
							userId,
						},
					});
				}
			}
		}

		return newCustomer;
	}

	public async getCustomerPaymentMethods(data: CustomerQueryData): Promise<Stripe.PaymentMethod[]> {
		const customer = await this.getCustomer(data);
		if (!customer) throw new Error('Customer not found.');

		const paymentMethods = await this.stripe.paymentMethods.list({ customer: customer.id });
		return paymentMethods.data || [];
	}

	private async getAllInvoicesInternal(options?: Stripe.InvoiceListParams, acc: Stripe.Invoice[] = [], startingAfter?: string): Promise<Stripe.Invoice[]> {
		const invoices = await this.stripe.invoices.list({ ...options, limit: 100, starting_after: startingAfter });
		acc.push(...invoices.data);

		if (invoices.has_more) return this.getAllInvoicesInternal(options, acc, invoices.data[invoices.data.length - 1]?.id);
		else return acc;
	}

	public async getCustomerInvoices(data: CustomerQueryData): Promise<Stripe.Invoice[]> {
		const customer = await this.getCustomer(data);
		if (!customer) throw new Error('Customer not found.');

		return await this.getAllInvoicesInternal({ customer: customer.id });
	}

	public async createBillingPortalSession(data: CustomerQueryData, flow?: Stripe.BillingPortal.SessionCreateParams.FlowData): Promise<Stripe.BillingPortal.Session> {
		const customer = await this.getCustomer(data);
		if (!customer) throw new Error('Customer not found.');

		return await this.stripe.billingPortal.sessions.create({
			customer: customer.id,
			return_url: this.manager.config.options?.stripe?.redirectUrl,
			flow_data: flow,
		});
	}
}
