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

export enum PaymentStatus {
	PaymentFailed = 'paymentFailed',
	RequiresAction = 'requiresAction',
	PendingPayment = 'pendingPayment',
}
