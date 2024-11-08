# Stripecord Documentation

**Stripecord**, a powerful package for integrating Stripe with your Discord bot, enabling easy subscription management with premium tiers and add-ons. This package allows you to manage and modify user subscriptions, handle webhooks from Stripe, and streamline the subscription process with add-ons and tier changes.

---

## Table of Contents

- [Introduction](#introduction)
- [Core Concepts](#core-concepts)
    - [Premium Tiers](#premium-tiers)
    - [Add-ons](#add-ons)
    - [Managing Subscriptions: Downgrades & Upgrades](#managing-subscriptions-downgrades--upgrades)
- [Installation](#installation)
- [Setup & Configuration](#setup--configuration)
- [Usage Examples](#usage-examples)
    - [Creating a Subscription](#creating-a-subscription)
    - [Changing Tiers](#changing-tiers)
    - [Managing Add-ons](#managing-add-ons)
- [Stripe Integration](#stripe-integration)
    - [Webhook Handling](#webhook-handling)
- [Events](#events)
- [API Reference](#api-reference)
- [FAQ](#faq)
- [License](#license)

---

## Introduction

`Stripecord` is designed to integrate Stripe's subscription management into your Discord bot, allowing you to set up **premium tiers** for your guilds or users and manage **add-ons** such as extra storage or features. It supports easy upgrades and downgrades between subscription tiers, making it ideal for managing multiple levels of access within your application.

---

## Core Concepts

Stripecord revolves around two primary concepts: **Premium Tiers** and **Add-ons**. Together, they give you the flexibility to provide different levels of service or content to your users.

### Premium Tiers

**Premium Tiers** represent different subscription plans that users or guilds can subscribe to. Each tier has its own price and benefits. Stripecord makes it easy to define these tiers, update them, and manage user subscriptions to them.

- **Tier Types**: Tiers can be set up for **guilds** or **users**. For instance, a guild premium tier might unlock additional features for the server, while a user premium tier could grant individual users additional functionalities.
- **Price Management**: Each tier has a defined price (in cents) that can be easily modified.
- **Upgrades and Downgrades**: Users or guilds can switch between tiers, whether they are upgrading to access additional features or downgrading due to budget constraints.

### Add-ons

**Add-ons** are optional features that can be added to a subscription to enhance the user's experience. Add-ons could be things like additional storage space, extra features, or premium support. 

- **Addon Management**: You can add or remove add-ons to existing subscriptions, and modify their prices and quantities.
- **Multiple Add-ons**: A user or guild can have multiple add-ons at the same time, which allows for a customizable experience based on their needs.

---

### Managing Subscriptions: Downgrades & Upgrades

One of the key features of Stripecord is its simplicity in handling **tier changes** (both upgrades and downgrades) and managing **add-ons** for subscriptions.

- **Upgrades**: Moving to a higher tier is straightforward. Users can simply subscribe to a new, higher tier to gain additional features.
- **Downgrades**: Similarly, users can downgrade to a lower tier. Stripecord ensures that the user's subscription changes smoothly, preserving their existing add-ons if applicable.
- **Add-on Modifications**: You can modify the add-ons associated with a subscription, either adding new ones, changing their quantity, or removing them entirely.

---

## Installation

To install **Stripecord**, you can use either npm or yarn:

```bash
npm install stripecord
```

or

```bash
yarn add stripecord
```

---

## Setup & Configuration

Before using **Stripecord**, you need to configure it by providing your **Stripe API key**, **Webhook Secret**, and defining your **premium tiers** and **add-ons**.

Here's a simple example of how to configure Stripecord:

```javascript
import { PremiumManager } from 'stripecord';
import express from 'express';

const manager = new PremiumManager({
  stripeApiKey: 'your-stripe-api-key',
  stripeWebhookSecret: 'your-stripe-webhook-secret',

  premiumTiers: [
    {
      type: 'guild',
      name: 'Guild Premium',
      priceCents: 500,
      tierId: 'guild_premium',
      isActive: true,
    },
    {
      type: 'guild',
      name: 'Guild Premium Plus',
      priceCents: 1000,
      tierId: 'guild_premium_plus',
      isActive: true,
    },
  ],
  addons: [
    {
      type: 'guild',
      name: 'Extra Storage',
      priceCents: 200,
      addonId: 'extra_storage',
      isActive: true,
    },
    {
      type: 'guild',
      name: 'Extra Features',
      priceCents: 300,
      addonId: 'extra_features',
      isActive: true,
    },
  ],
});
```

- **stripeApiKey**: Your Stripe API key to interact with Stripe's API.
- **stripeWebhookSecret**: The secret key for validating incoming webhooks from Stripe.
- **premiumTiers**: Define the subscription tiers available for your users.
- **addons**: Define optional add-ons that can be added to subscriptions.
- **options**: Additional configuration options for Stripe, such as automatic deletion of unknown tiers.

---

## Usage Examples

Below are some common use cases of how **Stripecord** is intended to be used.

### Creating a Subscription

To create a new subscription, you can use the `createCheckoutSession` method.

```javascript
const serverSub = await manager.stripeManager.subscriptions.createCheckoutSession({
  customer: { email: 'customer@example.com', userId: '12345' },
  tierId: 'guild_premium',
  guildId: '1234567890',
  addons: [],
  guildName: 'Test Guild',
});

// Now redirect the user to the checkout session URL.
console.log(serverSub.url);

```

### Changing Tiers

If you want to change a user's subscription tier, simply use the `changeSubscriptionTier` method.

```javascript
await manager.stripeManager.subscriptions.changeSubscriptionTier(subscriptionId, 'guild_premium_plus');
```

### Managing Add-ons

To add or update add-ons on a subscription:

```javascript
const updatedAddons = await manager.stripeManager.subscriptions.changeSubscriptionAddons(subscriptionId, [
  { ...manager.config.addons[0], quantity: 2 },  // Extra Storage
  { ...manager.config.addons[1], quantity: 3 },  // Extra Features
]);

console.log(updatedAddons);
```

### Getting User or Guild Subscriptions

To retrieve subscription details for a user or guild, Stripecord provides the following functions:

#### Get Subscriptions for a User and Guild

You can retrieve all subscriptions for a particular user or guild:

```javascript
const subscriptions = await manager.stripeManager.subscriptions.getSubscriptionsFor({
  customerId: 'user-id-or-guild-id',
});

console.log(subscriptions.user);  // User's subscription
console.log(subscriptions.guild); // Guild's subscriptions
```

#### Get User's Subscription

To fetch just a user's subscription:

```javascript
const userSubscription = await manager.stripeManager.subscriptions.getUserSubscription({
  customerId: 'user-id',
});

console.log(userSubscription); // Subscription details
```

#### Get Guild's Subscription

To fetch the subscription for a specific guild:

```javascript
const guildSubscription = await manager.stripeManager.subscriptions.getGuildSubscription({
  guildId: 'guild-id',
});

console.log(guildSubscription); // Guild's subscription
```

#### Get All Subscriptions for a Customer

To retrieve all subscriptions for a given customer:

```javascript
const allSubscriptions = await manager.stripeManager.subscriptions.getAllSubscriptions({
  customerId: 'customer-id',
  limit: 10,
  startingAfter: 'start-after-id',
});

console.log(allSubscriptions); // List of subscriptions
```

---

## Stripe Integration

**Stripecord** integrates seamlessly with Stripe to manage all your subscriptions. The main features are:

- **Stripe Tiers**: Sync your subscription tiers with Stripe, create new tiers, or modify existing ones.
- **Stripe Add-ons**: Sync add-ons with Stripe, create new ones, or modify the pricing and availability.
- **Webhook Handling**: Handle Stripe webhooks to automatically update your system with changes made on Stripe.

### Webhook Handling

You need to set up a webhook endpoint to listen to Stripe events and update your subscriptions accordingly.

```javascript
app.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const data = await manager.stripeManager.webhookHandler(req.body, req.headers['stripe-signature']);
  console.log(data);
  return res.status(data.status).send(data);
});
```

---

## Events

`Stripecord` emits various events to notify you when specific actions occur:

- **`subscriptionCreated`**: When a new subscription is created.
- **`subscriptionUpdated`**: When a subscription is updated.
- **`subscriptionCancelled`**: When a subscription is canceled.
- **`subscriptionDeleted`**: When a subscription is deleted.
- **`subscriptionTierChanged`**: When a subscription's tier is changed.
- **`subscriptionAddonsUpdated`**: When the add-ons associated with a subscription are updated.

We encourage you to listen for these events to keep track of subscription changes and updates. For example:

```javascript
manager.on('subscriptionCreated', (subscription) => {
  // grant access to features for subscription.userId and/or subscription.guildId
});

manager.on('subscriptionCancelled', (subscription) => {
  // revoke access to features for subscription.userId and/or subscription.guildId
});

manager.on('subscriptionTierChanged', (subscription) => {
  // update access based on the new tier for subscription.userId and/or subscription.guildId
});

manager.on('subscriptionAddonsUpdated', (subscription) => {
  // update access based on the new add-ons for subscription.userId and/or subscription.guildId
});
```

And that's it! You're now set up to handle subscription changes and updates in your Discord bot.

---

## API Reference

The core functionality of **Stripecord** revolves around the `StripeManager`, which handles all interactions with Stripe. Key components of the API include:

- **StripeTiers**: Manages Stripe subscription tiers.
- **StripeAddons**: Manages add-ons associated with subscriptions.
- **StripeSubscriptions**: Manages Stripe subscriptions, including creating, updating, and canceling subscriptions.
- **StripeCustomers**: Manages customer data, including creating and updating customer profiles.

---

## License

This package is licensed under the GNU General Public License v3.0. See the [LICENSE](LICENSE) file for more details.