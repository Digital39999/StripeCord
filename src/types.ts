import { ChargeType, PaymentStatus, WhatHappened } from './enums';
import Stripe from 'stripe';

export type ConfigType = {
	premiumTiers: PremiumTier[];
	addons: Addon[];

	stripeApiKey: string;
	stripeWebhookUrl: string;

	options?: {
		stripe?: {
			invoiceAllOnDisputeLoss?: boolean; // Invoicing might create another payment, for example, and that could lead to another dispute, which you might want to avoid. On the other hand, if there are outstanding items to bill for, you might want to make the attempt.
			deleteUnknownTiers?: boolean; // If a tier is deleted from the database, should it be deleted from Stripe as well?
			includeTaxInPrice?: boolean; // If the price includes tax, set this to true.
			defaultDueDays?: number; // Default number of days before payment is due for upgrades or addon changes.
			redirectUrl?: string; // URL to redirect to after a successful payment, only base URL is needed.
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
	currency?: string; // https://docs.stripe.com/currencies
	isActive: boolean;
};

export type Addon = {
	name: string;
	type: TierType;
	addonId: string;
	priceCents: number;
	currency?: string; // https://docs.stripe.com/currencies
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

    'guildSubscriptionCreate': [data: SubscriptionCreateData<'guild'>];
    'guildSubscriptionCancel': [data: SubscriptionCancelData<'guild'>];
    'guildSubscriptionDelete': [data: SubscriptionDeleteData<'guild'>];
    'guildSubscriptionUpdate': [data: SubscriptionUpdateData<'guild'>];
    'guildSubscriptionTierChange': [data: SubscriptionTierChangeData<'guild'>];
    'guildSubscriptionAddonsUpdate': [data: SubscriptionAddonChangeData<'guild'>];
    'guildSubscriptionRenew': [data: SubscriptionRenewData<'guild'>];

    'userSubscriptionCreate': [data: SubscriptionCreateData<'user'>];
    'userSubscriptionCancel': [data: SubscriptionCancelData<'user'>];
    'userSubscriptionDelete': [data: SubscriptionDeleteData<'user'>];
    'userSubscriptionUpdate': [data: SubscriptionUpdateData<'user'>];
    'userSubscriptionTierChange': [data: SubscriptionTierChangeData<'user'>];
    'userSubscriptionAddonsUpdate': [data: SubscriptionAddonChangeData<'user'>];
    'userSubscriptionRenew': [data: SubscriptionRenewData<'user'>];

    'unprocessedWebhook': [data: unknown];
    'invoiceNeedsPayment': [data: InvoiceNeedsPayment];
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

	addons: WithQuantity<StripeAddon>[];
};

export type InvoiceNeedsPayment<T extends TierType = TierType> = Omit<BaseSubscriptionData<T>, 'tier'> & {
	status: PaymentStatus;
	finalTotal: number;
	hostedUrl: string | null;

	raw: {
		subscription: Stripe.Subscription;
		invoice: Stripe.Invoice;
	};
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

	addons?: WithQuantity<Pick<Addon, 'addonId' | 'type'>>[];
	trialEndsAt?: Date;

	metadata?: Record<string, string>;
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
