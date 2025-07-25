import Stripe from 'stripe';

export type ConfigType = {
	premiumTiers: PremiumTier[];
	addons: Addon[];

	stripeApiKey: string;
	stripeWebhookUrl: string;
	stripeWebhookSecret?: string;

	options?: {
		stripe?: {
			cacheSubscriptions?: boolean; // If true, the manager will cache subscriptions for 5 minutes to reduce API calls.
			deleteUnknownTiers?: boolean; // If a tier is deleted from the database, should it be deleted from Stripe as well?
			includeTaxInPrice?: boolean; // If the price includes tax, set this to true.
			defaultDueDays?: number; // Default number of days before payment is due for upgrades or addon changes.
			redirectUrl?: string; // URL to redirect to after a successful payment, only base URL is needed.
		};
	};
};

export enum ChargeType {
	Immediate = 'immediate',
	EndOfPeriod = 'endOfPeriod',
	SendInvoice = 'sendInvoice'
}

export enum WhatHappened {
	Added = 'added',
	Removed = 'removed',
	Updated = 'updated',
	Nothing = 'nothing'
}

export enum CollectionMethod {
	ChargeAutomatically = 'chargeAutomatically',
	SendInvoice = 'sendInvoice',
}

export type TierType = 'guild' | 'user';
export type ManagerEventTypes = keyof ManagerEvents;

export type PremiumTier = {
	name: string;
	type: TierType;
	tierId: string;
	priceCents: number;
	yearlyMultiplier?: number;
	currency?: string; // https://docs.stripe.com/currencies
	isActive: boolean;
};

export type Addon = {
	name: string;
	type: TierType;
	addonId: string;
	priceCents: number;
	yearlyMultiplier?: number;
	currency?: string; // https://docs.stripe.com/currencies
	isActive: boolean;
};

export type StripeTier = PremiumTier & {
	monthlyPriceId: string;
	yearlyPriceId: string;
	stripeProductId: string;
};

export type StripeAddon = Addon & {
	yearlyPriceId: string;
	monthlyPriceId: string;
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

export type ManagerEvents = {
	'subscriptionCreate': [data: SubscriptionCreateData];
	'subscriptionCancel': [data: SubscriptionCancelData];
	'subscriptionDelete': [data: SubscriptionDeleteData];
	'subscriptionUpdate': [data: SubscriptionUpdateData];
	'subscriptionTierChange': [data: SubscriptionTierChangeData];
	'subscriptionAddonsUpdate': [data: SubscriptionAddonChangeData];
	'subscriptionRenew': [data: SubscriptionRenewData];

	'invoiceNeedsPayment': [data: InvoiceNeedsPayment];
	'invoicePaymentFailed': [data: InvoicePaymentFailed];

	'unprocessedWebhook': [data: unknown];
	'earlyFraudWarning': [data: Stripe.Radar.EarlyFraudWarning];
	'disputeWarning': [data: DisputeWarningData];
	'debug': [message: string];
};

export type WebhookResponse = {
	status: number;
	message: string;
};

export type BaseSubscriptionData<T extends TierType = TierType> = {
	type: T;
	tier: PremiumTier;

	userId: string;
	guildId: T extends 'guild' ? string : null;

	isAnnual: boolean;
	addons: WithQuantity<StripeAddon>[];
};

export type BaseInvoiceEvent<T extends TierType = TierType> = BaseSubscriptionData<T> & {
	finalTotal: number;

	attemptCount: number;
	autoHandled: boolean;

	collectionMethod: CollectionMethod;
	hostedUrl: string | null; // The URL for the hosted invoice page, which allows customers to view and pay an invoice. If the invoice has not been finalized yet, this will be null. So fetch the invoice and finalize it if needed.

	raw: {
		subscription: Stripe.Subscription;
		invoice: Stripe.Invoice;
	};
};

export type InvoiceNeedsPayment<T extends TierType = TierType> = BaseInvoiceEvent<T> & {
	dueDate: Date | null;
};

export type InvoicePaymentFailed<T extends TierType = TierType> = BaseInvoiceEvent<T> & {
	nextAttempt: Date | null;
};

export type SubscriptionCreateData<T extends TierType = TierType> = BaseSubscriptionData<T> & {
	raw: {
		subscription: Stripe.Subscription;
		invoice: Stripe.Invoice;
	};
};

export type SubscriptionRenewData<T extends TierType = TierType> = SubscriptionCreateData<T>;

export type SubscriptionUpdateData<T extends TierType = TierType> = BaseSubscriptionData<T> & {
	raw: {
		subscription: Stripe.Subscription;
		previous: Partial<Stripe.Subscription> | null;
	};
};

export type SubscriptionCancelData<T extends TierType = TierType> = SubscriptionUpdateData<T>;

export type SubscriptionTierChangeData<T extends TierType = TierType> = Omit<SubscriptionUpdateData<T>, 'tier'> & {
	newTier: PremiumTier;
	oldTier: PremiumTier;
};

export type SubscriptionDeleteData<T extends TierType = TierType> = BaseSubscriptionData<T> & {
	raw: {
		subscription: Stripe.Subscription;
	};
};

export type SubscriptionAddonChangeData<T extends TierType = TierType> = Omit<SubscriptionUpdateData<T>, 'addons'> & {
	currentAddons: WithQuantity<StripeAddon>[];
	addonUpdates: AddonUpdateType[];
};

export type AddonUpdateType = {
	whatHappened: WhatHappened;
	addon: StripeAddon;
	qty: number;
};

export type SubscriptionCreateInputData = {
	customer: CustomerCreateData;
	tierId: string;

	guildId?: string;
	guildName?: string;

	addons?: WithQuantity<Pick<Addon, 'addonId'>>[];
	trialEndsAt?: Date;

	metadata?: Record<string, string>;
	isAnnual?: boolean;
};

export type ChargeOptions = {
	chargeType: ChargeType;
	dueDays?: number;
};

export type DisputeWarningData = {
	reason: string;
	amount: number;

	isRefundable: boolean;
	dashboardUrl: string;

	raw: {
		dispute: Stripe.Dispute;
		charge: Stripe.Charge | null;
	};
};
