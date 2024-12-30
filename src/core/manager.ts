import { ConfigType, ManagerEvents } from '../types';
import StripeManager from './stripe';
import EventEmitter from 'events';

export class PremiumManager extends EventEmitter {
	public stripeManager: StripeManager;

	constructor(readonly config: ConfigType) {
		super();

		this.stripeManager = new StripeManager(this);
	}

	public async syncAll() {
		await Promise.all([
			this.stripeManager.syncAll(),
		]);
	}

	emit<K extends keyof ManagerEvents>(event: K, ...args: ManagerEvents[K]) {
		return super.emit(event, ...args);
	}

	on<K extends keyof ManagerEvents>(event: K, listener: (...args: ManagerEvents[K]) => void) {
		return super.on(event, listener);
	}

	once<K extends keyof ManagerEvents>(event: K, listener: (...args: ManagerEvents[K]) => void) {
		return super.once(event, listener);
	}

	off<K extends keyof ManagerEvents>(event: K, listener: (...args: ManagerEvents[K]) => void) {
		return super.off(event, listener);
	}

	removeListener<K extends keyof ManagerEvents>(event: K, listener: (...args: ManagerEvents[K]) => void) {
		return super.removeListener(event, listener);
	}
}
