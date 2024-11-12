import Stripe from 'stripe';

export type DeepNonNullable<T> = T extends NonNullable<T> ? T : DeepNonNullable<NonNullable<T>>;

export type ConfigType = {
	premiumTiers: PremiumTier[];
	addons: Addon[];

	stripeApiKey: string;
	stripeWebhookSecret: string;

	options?: {
		stripe?: {
			includeTaxInPrice?: boolean;
			deleteUnknownTiers?: boolean;
			redirectUrl?: string;
		};
	};
};

export type TierType = 'guild' | 'user';
export type ManagerEventTypes = keyof ManagerEvents;

export type PremiumTier = {
	name: string;
	type: TierType;
	tierId: string;
	priceCents: number;
	isActive: boolean;
};

export type Addon = {
	name: string;
	type: TierType;
	addonId: string;
	priceCents: number;
	isActive: boolean;
};

export type StripeTier = PremiumTier & {
	stripePriceId: string;
	stripeProductId: string;
};

export type StripeAddon = Addon & {
	stripePriceId: string;
	stripeProductId: string;
};

export type WithQuantity<T> = T & {
	quantity: number;
};

export type CustomerCreateData = {
	userId: string;
	email: string;
};

export type CustomerQueryData = CustomerCreateData | {
	customerId: string;
};

export type CustomerUpdateData = {
	newEmail: string;
	newUserId: string;
};

export type GetAllCustomersQuery = {
	email?: string;
	limit?: number;
	startingAfter?: string;
};

export type GetAllSubscriptionsQuery = {
	customerId?: string;
	limit?: number;
	startingAfter?: string;
};

export type GetAllInvoicesQuery = GetAllSubscriptionsQuery;

export type ManagerEvents = {
	'subscriptionCreate': [data: SubscriptionCreateData];
	'subscriptionCancel': [data: SubscriptionCancelData];
	'subscriptionDelete': [data: SubscriptionDeleteData];
	'subscriptionUpdate': [data: SubscriptionUpdateData];
	'subscriptionTierChange': [data: SubscriptionTierChangeData];
	'subscriptionAddonsUpdate': [data: SubscriptionAddonChangeData];
	'subscriptionRenew': [data: SubscriptionRenewData];

	'guildSubscriptionCreate': [data: SubscriptionCreateData];
	'guildSubscriptionCancel': [data: SubscriptionCancelData];
	'guildSubscriptionDelete': [data: SubscriptionDeleteData];
	'guildSubscriptionUpdate': [data: SubscriptionUpdateData];
	'guildSubscriptionTierChange': [data: SubscriptionTierChangeData];
	'guildSubscriptionAddonsUpdate': [data: SubscriptionAddonChangeData];
	'guildSubscriptionRenew': [data: SubscriptionRenewData];

	'userSubscriptionCreate': [data: SubscriptionCreateData];
	'userSubscriptionCancel': [data: SubscriptionCancelData];
	'userSubscriptionDelete': [data: SubscriptionDeleteData];
	'userSubscriptionUpdate': [data: SubscriptionUpdateData];
	'userSubscriptionTierChange': [data: SubscriptionTierChangeData];
	'userSubscriptionAddonsUpdate': [data: SubscriptionAddonChangeData];
	'userSubscriptionRenew': [data: SubscriptionRenewData];

	'unprocessedWebhook': [data: unknown];
	'paymentFailed': [data: PaymentFailedData];
	'debug': [message: string];
};

export type WebhookResponse = {
	status: number;
	message: string;
};

export type BaseSubscriptionData = {
	type: TierType;
	tierId: string;

	userId: string;
	guildId: string | null;

	addons: WithQuantity<StripeAddon>[];
};

export type PaymentFailedData = Omit<BaseSubscriptionData, 'tierId'> & {
	raw: {
		subscription: Stripe.Subscription;
		invoice: Stripe.Invoice;
	};
};

export type SubscriptionCreateData = BaseSubscriptionData & {
	raw: {
		subscription: Stripe.Subscription;
		invoice: Stripe.Invoice;
	};
};

export type SubscriptionRenewData = SubscriptionCreateData;

export type SubscriptionUpdateData = BaseSubscriptionData & {
	raw: {
		subscription: Stripe.Subscription;
		previous: Partial<Stripe.Subscription> | null;
	};
};

export type SubscriptionCancelData = SubscriptionUpdateData;

export type SubscriptionTierChangeData = Omit<SubscriptionUpdateData, 'tierId'> & {
	newTierId: string;
	oldTierId: string;
};

export type SubscriptionDeleteData = BaseSubscriptionData & {
	raw: {
		subscription: Stripe.Subscription;
	};
};

export type SubscriptionAddonChangeData = Omit<SubscriptionUpdateData, 'addons'> & {
	currentAddons: WithQuantity<StripeAddon>[];
	addonUpdates: AddonUpdateType[];
};

export type AddonUpdateType = {
	whatHappened: 'added' | 'removed' | 'updated' | 'nothing';
	addon: StripeAddon;
	qty: number;
};

export type SubscriptionCreateInputData = {
	customer: CustomerCreateData;
	tierId: string;

	guildId: string | null;
	guildName: string | null;

	addons: WithQuantity<Addon>[];
	trialEndsAt?: Date;

	metadata?: Record<string, string>;
};
