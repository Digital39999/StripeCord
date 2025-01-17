import { Addon, AddonUpdateType, ChargeOptions, CustomerCreateData, CustomerQueryData, CustomerUpdateData, GetAllCustomersQuery, GetAllInvoicesQuery, GetAllSubscriptionsQuery, PremiumTier, StripeAddon, StripeTier, SubscriptionCreateInputData, WebhookResponse, WithQuantity } from '../types';
import { PaymentStatus, WhatHappened } from '../enums';
import { PremiumManager } from './manager';
import { stringifyError } from '../utils';
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
			case 'invoice.finalized':
			case 'invoice.payment_failed':
			case 'invoice.payment_action_required': {
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

					let status: PaymentStatus;

					switch (event.type) {
						case 'invoice.finalized': status = PaymentStatus.PendingPayment; break;
						case 'invoice.payment_failed': status = PaymentStatus.PaymentFailed; break;
						case 'invoice.payment_action_required': status = PaymentStatus.RequiresAction; break;
						default: status = PaymentStatus.PendingPayment; break;
					}

					const eventData = {
						type: subscriptionType,

						isAnnual: subscription.data.metadata.isAnnual === 'true',
						addons: await this.addons.getAddonsFromItems(subscription.data.items.data) ?? [],

						status: status,
						finalTotal: invoice.data.total,
						hostedUrl: invoice.data.hosted_invoice_url ?? null,

						userId: subscription.data.metadata.userId,
						guildId: subscription.data.metadata.guildId ?? null,

						raw: {
							subscription: subscription.data,
							invoice: invoice.data,
						},
					} as const;

					this.manager.emit('invoiceNeedsPayment', eventData);
				}

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
}

export class StripeTiers {
	constructor (private readonly manager: PremiumManager, private readonly stripe: Stripe) { }

	private async createTier(data: PremiumTier): Promise<Stripe.Product> {
		const products = await this.stripe.products.list();
		let product = products.data.find((p) => p.metadata._internal_id === data.tierId && p.metadata._internal_type === data.type);

		if (!product) {
			product = await this.stripe.products.create({
				name: data.name,
				metadata: {
					_internal_type: data.type,
					_internal_id: data.tierId,
				},
			});
		} else {
			await this.stripe.products.update(product.id, { active: true });
		}

		const createOrUpdatePrice = async (interval: 'month' | 'year', amount: number): Promise<Stripe.Price> => {
			const existingPrices = await this.stripe.prices.list({ product: product!.id });
			const existingPrice = existingPrices.data.find((price) => price.unit_amount === amount && price.recurring?.interval === interval);

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
				},
			});
		};

		const monthlyPrice = await createOrUpdatePrice('month', data.priceCents).catch(() => null);
		const yearlyPrice = await createOrUpdatePrice('year', data.priceCents * 10).catch(() => null);
		if (!monthlyPrice || !yearlyPrice) throw new Error('Failed to create or update prices for tier.');

		await this.stripe.products.update(product.id, { default_price: monthlyPrice.id });
		return product;
	}

	public async getStripeTiers(): Promise<StripeTier[]> {
		const products = await this.stripe.products.list();
		const tiers: StripeTier[] = [];

		for await (const product of products.data) {
			const prices = await this.stripe.prices.list({ product: product.id });

			const monthlyPrice = prices.data.find((price) => price.recurring?.interval === 'month');
			const yearlyPrice = prices.data.find((price) => price.recurring?.interval === 'year');
			if (!monthlyPrice || !yearlyPrice) continue;

			const tierId = product.metadata._internal_id;
			const tierType = product.metadata._internal_type;

			if (!tierId || !tierType) continue;
			else if (!['guild', 'user'].includes(tierType)) throw new Error(`Invalid tier type for product ${product.id}: ${tierType}`);

			tiers.push({
				tierId,
				type: tierType as 'guild' | 'user',
				name: product.name,
				isActive: product.active,
				priceCents: monthlyPrice.unit_amount ?? 0,
				stripeProductId: product.id,
				monthyPriceId: monthlyPrice.id,
				yearlyPriceId: yearlyPrice.id,
			});
		}

		return tiers;
	}

	private async changeActiveState(tierId: string, isActive: boolean): Promise<boolean> {
		const tiers = await this.getStripeTiers();
		const tier = tiers.find((tier) => tier.tierId === tierId);
		if (!tier) throw new Error(`Tier not found for ID ${tierId}.`);

		await this.stripe.products.update(tier.stripeProductId, {
			active: isActive,
		});

		return true;
	}

	private async changePrice(tierId: string, priceCents: number, currency?: string): Promise<boolean> {
		const tiers = await this.getStripeTiers();
		const tier = tiers.find((tier) => tier.tierId === tierId);
		if (!tier) throw new Error(`Tier not found for ID ${tierId}.`);
		else if (priceCents === tier.priceCents) return true;

		const monthlyPrice = await this.stripe.prices.retrieve(tier.monthyPriceId).catch(() => null);
		const yearlyPrice = await this.stripe.prices.retrieve(tier.yearlyPriceId).catch(() => null);
		if (!monthlyPrice || !yearlyPrice) throw new Error('Failed to retrieve prices for tier.');

		const allPrices = await this.stripe.prices.list();

		const newMonthlyPrice = allPrices.data.find((price) =>
			price.active === true &&
			price.currency === currency &&
			price.unit_amount === priceCents &&
			price.recurring?.interval === 'month' &&
			price.metadata._internal_id === tierId &&
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
			},
		}).catch(() => null);

		const newYearlyPrice = allPrices.data.find((price) =>
			price.active === true &&
			price.currency === currency &&
			price.unit_amount === priceCents * 10 &&
			price.recurring?.interval === 'year' &&
			price.metadata._internal_id === tierId &&
			price.metadata._internal_type === tier.type,
		) || await this.stripe.prices.create({
			unit_amount: priceCents * 10,
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
			},
		}).catch(() => null);

		if (!newMonthlyPrice || !newYearlyPrice) throw new Error('Failed to create or update prices for tier.');

		await this.stripe.products.update(tier.stripeProductId, { default_price: newMonthlyPrice.id });
		if (newMonthlyPrice.id !== monthlyPrice.id) await this.stripe.prices.update(monthlyPrice.id, { active: false });
		if (newYearlyPrice.id !== yearlyPrice.id) await this.stripe.prices.update(yearlyPrice.id, { active: false });

		return true;
	}

	private async deleteTier(tierId: string): Promise<boolean> {
		const tiers = await this.getStripeTiers();
		const tier = tiers.find((tier) => tier.tierId === tierId);
		if (!tier) throw new Error(`Tier not found for ID ${tierId}.`);

		await this.stripe.products.update(tier.stripeProductId, {
			active: false,
		});

		await this.stripe.prices.update(tier.monthyPriceId, {
			active: false,
		});

		await this.stripe.prices.update(tier.yearlyPriceId, {
			active: false,
		});

		return true;
	}

	public async syncOrCreateTiers(): Promise<void> {
		const stripeTiers = await this.getStripeTiers();
		const stripeTierIds = stripeTiers.map((tier) => tier.tierId);

		const missingTiers = this.manager.config.premiumTiers.filter((tier) => !stripeTierIds.includes(tier.tierId));
		const foundTiers = this.manager.config.premiumTiers.filter((tier) => stripeTierIds.includes(tier.tierId));
		const extraTiers = stripeTiers.filter((tier) => !this.manager.config.premiumTiers.some((t) => t.tierId === tier.tierId));

		await this.createMissingTiers(missingTiers);
		await this.updateExistingTiers(foundTiers, stripeTiers);

		if (this.manager.config.options?.stripe?.deleteUnknownTiers) {
			await this.deleteExtraTiers(extraTiers);
		}
	}

	private async createMissingTiers(missingTiers: PremiumTier[]): Promise<void> {
		await Promise.allSettled(missingTiers.map((tier) => this.createTier(tier)));
	}

	private async updateExistingTiers(foundTiers: PremiumTier[], stripeTiers: StripeTier[]): Promise<void> {
		for (const tier of foundTiers) {
			const stripeTier = stripeTiers.find((t) => t.tierId === tier.tierId);
			if (!stripeTier) continue;

			if (stripeTier.priceCents !== tier.priceCents) {
				await this.changePrice(tier.tierId, tier.priceCents, tier.currency);
			}

			if (stripeTier.isActive !== tier.isActive) {
				await this.changeActiveState(tier.tierId, tier.isActive);
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
					},
				});
			}
		}
	}

	private async deleteExtraTiers(extraTiers: StripeTier[]): Promise<void> {
		await Promise.allSettled(extraTiers.map((tier) => this.deleteTier(tier.tierId)));
	}

	public async getTiersFromItems(items: Stripe.SubscriptionItem[], stripeTiers?: StripeTier[]): Promise<StripeTier[]> {
		if (!items.length) return [];

		const tiers = stripeTiers || await this.getStripeTiers();
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
		const stripeTiers = await this.getStripeTiers();

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

	private async createAddon(data: Addon): Promise<Stripe.Product> {
		const products = await this.stripe.products.list();
		let product = products.data.find((p) => p.metadata._internal_id === data.addonId && p.metadata._internal_type === data.type);

		if (!product) {
			product = await this.stripe.products.create({
				name: data.name,
				metadata: {
					_internal_type: data.type,
					_internal_id: data.addonId,
				},
			});
		} else {
			await this.stripe.products.update(product.id, { active: true });
		}

		const createOrUpdatePrice = async (interval: 'month' | 'year', amount: number): Promise<Stripe.Price> => {
			const existingPrices = await this.stripe.prices.list({ product: product!.id });
			const existingPrice = existingPrices.data.find((price) => price.unit_amount === amount && price.recurring?.interval === interval);

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
				},
			});
		};

		const monthlyPrice = await createOrUpdatePrice('month', data.priceCents).catch(() => null);
		const yearlyPrice = await createOrUpdatePrice('year', data.priceCents * 10).catch(() => null);
		if (!monthlyPrice || !yearlyPrice) throw new Error('Failed to create or update prices for addon.');

		await this.stripe.products.update(product.id, { default_price: monthlyPrice.id });
		return product;
	}

	public async getStripeAddons(): Promise<StripeAddon[]> {
		const products = await this.stripe.products.list();
		const addons: StripeAddon[] = [];

		for await (const product of products.data) {
			const prices = await this.stripe.prices.list({ product: product.id });

			const monthlyPrice = prices.data.find((price) => price.recurring?.interval === 'month');
			const yearlyPrice = prices.data.find((price) => price.recurring?.interval === 'year');
			if (!monthlyPrice || !yearlyPrice) continue;

			const addonId = product.metadata._internal_id;
			const addonType = product.metadata._internal_type;

			if (!addonId || !addonType) continue;
			else if (!['guild', 'user'].includes(addonType)) throw new Error(`Invalid addon type for product ${product.id}: ${addonType}`);

			addons.push({
				addonId,
				type: addonType as 'guild' | 'user',
				name: product.name,
				isActive: product.active,
				priceCents: monthlyPrice.unit_amount ?? 0,
				stripeProductId: product.id,
				monthyPriceId: monthlyPrice.id,
				yearlyPriceId: yearlyPrice.id,
			});
		}

		return addons;
	}

	private async changeActiveState(addonId: string, isActive: boolean): Promise<boolean> {
		const addons = await this.getStripeAddons();
		const addon = addons.find((addon) => addon.addonId === addonId);
		if (!addon) throw new Error(`Addon not found for ID ${addonId}.`);

		await this.stripe.products.update(addon.stripeProductId, {
			active: isActive,
		});

		return true;
	}

	private async changePrice(addonId: string, priceCents: number, currency?: string): Promise<boolean> {
		const addons = await this.getStripeAddons();
		const addon = addons.find((addon) => addon.addonId === addonId);
		if (!addon) throw new Error(`Addon not found for ID ${addonId}.`);
		else if (priceCents === addon.priceCents) return true;

		const monthlyPrice = await this.stripe.prices.retrieve(addon.monthyPriceId).catch(() => null);
		const yearlyPrice = await this.stripe.prices.retrieve(addon.yearlyPriceId).catch(() => null);
		if (!monthlyPrice || !yearlyPrice) throw new Error('Failed to retrieve prices for addon.');

		const allPrices = await this.stripe.prices.list();

		const newMonthlyPrice = allPrices.data.find((price) =>
			price.active === true &&
			price.currency === currency &&
			price.unit_amount === priceCents &&
			price.recurring?.interval === 'month' &&
			price.metadata._internal_id === addonId &&
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
			},
		}).catch(() => null);

		const newYearlyPrice = allPrices.data.find((price) =>
			price.active === true &&
			price.currency === currency &&
			price.unit_amount === priceCents * 10 &&
			price.recurring?.interval === 'year' &&
			price.metadata._internal_id === addonId &&
			price.metadata._internal_type === addon.type,
		) || await this.stripe.prices.create({
			unit_amount: priceCents * 10,
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
			},
		}).catch(() => null);

		if (!newMonthlyPrice || !newYearlyPrice) throw new Error('Failed to create or update prices for addon.');

		await this.stripe.products.update(addon.stripeProductId, { default_price: newMonthlyPrice.id });
		if (newMonthlyPrice.id !== monthlyPrice.id) await this.stripe.prices.update(monthlyPrice.id, { active: false });
		if (newYearlyPrice.id !== yearlyPrice.id) await this.stripe.prices.update(yearlyPrice.id, { active: false });

		return true;
	}

	private async deleteAddon(addonId: string): Promise<boolean> {
		const addons = await this.getStripeAddons();
		const addon = addons.find((addon) => addon.addonId === addonId);
		if (!addon) throw new Error(`Addon not found for ID ${addonId}.`);

		await this.stripe.products.update(addon.stripeProductId, {
			active: false,
		});

		await this.stripe.prices.update(addon.monthyPriceId, {
			active: false,
		});

		await this.stripe.prices.update(addon.yearlyPriceId, {
			active: false,
		});

		return true;
	}

	public async syncOrCreateAddons(): Promise<void> {
		const stripeAddons = await this.getStripeAddons();
		const stripeAddonIds = stripeAddons.map((addon) => addon.addonId);

		const missingAddons = this.manager.config.addons.filter((addon) => !stripeAddonIds.includes(addon.addonId));
		const foundAddons = this.manager.config.addons.filter((addon) => stripeAddonIds.includes(addon.addonId));
		const extraAddons = stripeAddons.filter((addon) => !this.manager.config.addons.some((a) => a.addonId === addon.addonId));

		await this.createMissingAddons(missingAddons);
		await this.updateExistingAddons(foundAddons, stripeAddons);

		if (this.manager.config.options?.stripe?.deleteUnknownTiers) {
			await this.deleteExtraAddons(extraAddons);
		}
	}

	private async createMissingAddons(missingAddons: Addon[]): Promise<void> {
		await Promise.allSettled(missingAddons.map((addon) => this.createAddon(addon)));
	}

	private async updateExistingAddons(foundAddons: Addon[], stripeAddons: StripeAddon[]): Promise<void> {
		for (const addon of foundAddons) {
			const stripeAddon = stripeAddons.find((a) => a.addonId === addon.addonId);
			if (!stripeAddon) continue;

			if (stripeAddon.priceCents !== addon.priceCents) {
				await this.changePrice(addon.addonId, addon.priceCents, addon.currency);
			}

			if (stripeAddon.isActive !== addon.isActive) {
				await this.changeActiveState(addon.addonId, addon.isActive);
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
					},
				});
			}
		}
	}

	private async deleteExtraAddons(extraAddons: StripeAddon[]): Promise<void> {
		await Promise.allSettled(extraAddons.map((addon) => this.deleteAddon(addon.addonId)));
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

	public async getSubscriptionsFor(options: CustomerQueryData): Promise<{ user: Stripe.Subscription | null; guild: Stripe.Subscription[]; }> {
		const customer = await this.stripeManager.customers.getCustomer(options);
		if (!customer) throw new Error('Failed to get customer.');

		const subscriptions = await this.getAllSubscriptions({ customerId: customer.id });
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
		const subscriptions = await this.getAllSubscriptions({});
		return subscriptions.find((sub) => sub.metadata.guildId === guildId) || null;
	}

	public async getAllSubscriptions({ customerId, limit = 100, startingAfter }: GetAllSubscriptionsQuery): Promise<Stripe.Subscription[]> {
		const subscriptions = await this.stripe?.subscriptions.list({ customer: customerId, limit, starting_after: startingAfter });

		if (!subscriptions) return [];
		else if (subscriptions.has_more) return [...(subscriptions.data || []), ...(await this.getAllSubscriptions({ customerId, limit, startingAfter: subscriptions.data[subscriptions.data.length - 1]?.id }) || [])];
		else return subscriptions.data || [];
	}

	public async cancelSubscription(subscriptionId: string, immediately = false): Promise<boolean> {
		const subscription = await this.stripe.subscriptions.retrieve(subscriptionId).catch(() => null);
		if (!subscription) throw new Error(`Subscription not found for ID ${subscriptionId}.`);

		if (immediately) await this.stripe.subscriptions.cancel(subscriptionId, { invoice_now: true });
		else await this.stripe.subscriptions.update(subscriptionId, { cancel_at_period_end: true });

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
		if (!tierData) throw new Error(`Tier not found for ID ${data.tierId}.`);

		const joinIfExists = (s1: string | null, s2: string) => s1 ? `${s1}${s2}` : `https://example.com/checkout${s2}`;

		switch (tierData.type) {
			case 'user': {
				const isAnyAddonNotUser = data.addons?.some((addon) => addon.type !== 'user');
				if (isAnyAddonNotUser) throw new Error('User subscriptions cannot have guild addons.');
				else if (data.guildId) throw new Error('User subscriptions cannot be created for guilds.');

				const customer = await this.stripeManager.customers.getOrCreateCustomer(data.customer);
				if (!customer) throw new Error('Failed to create or get customer.');
				else if (!customer.metadata.userId) throw new Error('Missing user ID in customer.');

				const userSub = await this.getUserSubscription({ customerId: customer.id });
				if (userSub) throw new Error('User already has a user subscription.');

				const daysForTrial = data.trialEndsAt ? Math.round((data.trialEndsAt.getTime() - Date.now()) / 86400000) : 0;
				const lineItems: Stripe.Checkout.SessionCreateParams.LineItem[] = [{
					price: data.isAnnual ? tierData.yearlyPriceId : tierData.monthyPriceId,
					quantity: 1,
				}];

				const stripeAddons = data.addons?.length ? await this.stripeManager.addons.getStripeAddons() : [];

				for (const addon of data.addons || []) {
					const addonData = stripeAddons.find((a) => a.addonId === addon.addonId);
					if (!addonData) throw new Error(`Addon not found for ID ${addon.addonId}.`);

					lineItems.push({
						price: data.isAnnual ? addonData.yearlyPriceId : addonData.monthyPriceId,
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
				const isAnyAddonNotGuild = data.addons?.some((addon) => addon.type !== 'guild');
				if (isAnyAddonNotGuild) throw new Error('Guild subscriptions cannot have user addons.');
				else if (!data.guildId) throw new Error('Guild subscriptions must be created for guilds.');

				const customer = await this.stripeManager.customers.getOrCreateCustomer(data.customer);
				if (!customer) throw new Error('Failed to create or get customer.');
				else if (!customer.metadata.userId) throw new Error('Missing user ID in customer.');

				const guildSub = await this.getGuildSubscription({ guildId: data.guildId });
				if (guildSub) throw new Error('Guild already has a guild subscription.');

				const daysForTrial = data.trialEndsAt ? Math.round((data.trialEndsAt.getTime() - Date.now()) / 86400000) : 0;
				const lineItems: Stripe.Checkout.SessionCreateParams.LineItem[] = [{
					price: data.isAnnual ? tierData.yearlyPriceId : tierData.monthyPriceId,
					quantity: 1,
				}];

				const stripeAddons = data.addons?.length ? await this.stripeManager.addons.getStripeAddons() : [];

				for (const addon of data.addons || []) {
					const addonData = stripeAddons.find((a) => a.addonId === addon.addonId);
					if (!addonData) throw new Error(`Addon not found for ID ${addon.addonId}.`);

					lineItems.push({
						price: data.isAnnual ? addonData.yearlyPriceId : addonData.monthyPriceId,
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
						description: `Subscription for ${data.guildName ? data.guildName : `guild ${data.guildId}`}.`,
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
		if (!subscription) throw new Error(`Subscription not found for ID ${subscriptionId}.`);
		else if (!subscription.metadata.userId) throw new Error(`Missing user ID in subscription ${subscriptionId}.`);
		else if (!subscription.metadata.isUserSub && !subscription.metadata.guildId) throw new Error(`Missing guild ID in subscription ${subscriptionId}.`);
		else if (subscription.metadata.tierId === newTierId) return true;

		const customerId = typeof subscription.customer === 'string' ? subscription.customer : subscription.customer.id;
		if (!customerId) throw new Error(`Missing customer ID in subscription ${subscriptionId}.`);

		const stripeTiers = await this.stripeManager.tiers.getStripeTiers();
		if (!stripeTiers.length) throw new Error('Tiers not found.');

		const newTierPrice = stripeTiers.find((tier) => tier.tierId === newTierId);
		if (!newTierPrice) throw new Error(`Tier not found for ID ${newTierId}.`);

		const subscriptionType = subscription.metadata.isUserSub === 'true' ? 'user' : 'guild';
		if (newTierPrice.type !== subscriptionType) throw new Error(`${subscriptionType === 'user' ? 'User' : 'Guild'} subscriptions cannot have tiers for the other type.`);

		const itemThatIsMainTier = subscription.items.data.find((item) => item.price.metadata._internal_id === subscription.metadata.tierId);
		if (!itemThatIsMainTier) throw new Error(`Main tier not found for subscription ${subscriptionId}.`);

		const newItems: Stripe.SubscriptionUpdateParams.Item[] = [{
			id: itemThatIsMainTier.id,
			price: subscription.metadata.isAnnual ? newTierPrice.yearlyPriceId : newTierPrice.monthyPriceId,
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
		if (!subscription) throw new Error(`Subscription not found for ID ${subscriptionId}.`);
		else if (!subscription.metadata.userId) throw new Error(`Missing user ID in subscription ${subscriptionId}.`);
		else if (!subscription.metadata.isUserSub && !subscription.metadata.guildId) throw new Error(`Missing guild ID in subscription ${subscriptionId}.`);

		const customerId = typeof subscription.customer === 'string' ? subscription.customer : subscription.customer.id;
		if (!customerId) throw new Error(`Missing customer ID in subscription ${subscriptionId}.`);

		const stripeAddons = await this.stripeManager.addons.getStripeAddons();
		if (!stripeAddons.length) throw new Error('Addons not found.');

		const itemThatIsMainTier = subscription.items.data.find((item) => item.price.metadata._internal_id === subscription.metadata.tierId);
		if (!itemThatIsMainTier) throw new Error(`Main tier not found for subscription ${subscriptionId}.`);

		const newSelectedAddons = stripeAddons.filter((addon) => newAddons.some((newAddon) => newAddon.addonId === addon.addonId));

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

		for (const addon of newAddons) {
			const addonData = stripeAddons.find((a) => a.addonId === addon.addonId);
			if (!addonData) throw new Error(`Addon not found for ID ${addon.addonId}.`);

			const existingItem = subscription.items.data.find((item) => item.price.metadata._internal_id === addon.addonId);
			if (existingItem) {
				newItems.push({
					id: existingItem.id,
					price: existingItem.price.id,
					quantity: addon.quantity,
				});
			} else {
				newItems.push({
					price: subscription.metadata.isAnnual === 'true' ? addonData.yearlyPriceId : addonData.monthyPriceId,
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
			const customers = await this.getAllCustomers({ email: data.email });
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

	public async getAllCustomers({ email, limit = 100, startingAfter }: GetAllCustomersQuery): Promise<Stripe.Customer[]> {
		const customers = await this.stripe.customers.list({ email, limit, starting_after: startingAfter });

		if (!customers) return [];
		else if (customers.has_more) return [...(customers.data || []), ...(await this.getAllCustomers({ email, limit, startingAfter: customers.data[customers.data.length - 1]?.id }) || [])];
		else return customers.data || [];
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

	public async getCustomerInvoices(data: CustomerQueryData): Promise<Stripe.Invoice[]> {
		const customer = await this.getCustomer(data);
		if (!customer) throw new Error('Customer not found.');

		return await this.getAllInvoices({ customerId: customer.id });
	}

	public async getAllInvoices({ customerId, limit = 100, startingAfter }: GetAllInvoicesQuery): Promise<Stripe.Invoice[]> {
		const invoices = await this.stripe.invoices.list({ customer: customerId, limit, starting_after: startingAfter });

		if (!invoices) return [];
		else if (invoices.has_more) return [...(invoices.data || []), ...(await this.getAllInvoices({ customerId, limit, startingAfter: invoices.data[invoices.data.length - 1]?.id }) || [])];
		else return invoices.data || [];
	}

	public async createChangePaymentMethodSession(data: CustomerQueryData): Promise<Stripe.BillingPortal.Session> {
		const customer = await this.getCustomer(data);
		if (!customer) throw new Error('Customer not found.');

		return await this.stripe.billingPortal.sessions.create({
			customer: customer.id,
			return_url: this.manager.config.options?.stripe?.redirectUrl,
			flow_data: {
				type: 'payment_method_update',
			},
		});
	}
}
