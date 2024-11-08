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
	'subscriptionCreated': [data: SubscriptionCreateData];
	'subscriptionCancelled': [data: SubscriptionCancelData];
	'subscriptionDeleted': [data: SubscriptionDeleteData];
	'subscriptionUpdated': [data: SubscriptionUpdateData];
	'subscriptionTierChanged': [data: SubscriptionTierChangeData];
	'subscriptionAddonsUpdated': [data: SubscriptionAddonChangeData];
	'subscriptionRenewed': [data: SubscriptionRenewData];

	'guildSubscriptionCreated': [data: SubscriptionCreateData];
	'guildSubscriptionCancelled': [data: SubscriptionCancelData];
	'guildSubscriptionDeleted': [data: SubscriptionDeleteData];
	'guildSubscriptionUpdated': [data: SubscriptionUpdateData];
	'guildSubscriptionTierChanged': [data: SubscriptionTierChangeData];
	'guildSubscriptionAddonsUpdated': [data: SubscriptionAddonChangeData];
	'guildSubscriptionRenewed': [data: SubscriptionRenewData];

	'userSubscriptionCreated': [data: SubscriptionCreateData];
	'userSubscriptionCancelled': [data: SubscriptionCancelData];
	'userSubscriptionDeleted': [data: SubscriptionDeleteData];
	'userSubscriptionUpdated': [data: SubscriptionUpdateData];
	'userSubscriptionTierChanged': [data: SubscriptionTierChangeData];
	'userSubscriptionAddonsUpdated': [data: SubscriptionAddonChangeData];
	'userSubscriptionRenewed': [data: SubscriptionRenewData];

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
