export class TimedSet<K> {
	private entries: Map<K, number> = new Map();

	constructor (private ttlMs: number = 1000 * 60 * 60) {
		setInterval(() => this.cleanup(), Math.floor(ttlMs / 3));
	}

	public add(id: K): void {
		this.entries.set(id, Date.now());
	}

	public has(id: K): boolean {
		return this.entries.has(id);
	}

	private cleanup(): void {
		const now = Date.now();
		for (const [id, timestamp] of this.entries) {
			if (now - timestamp > this.ttlMs) {
				this.entries.delete(id);
			}
		}
	}
}

export class TimedMap<K, V> {
	private entries: Map<K, { value: V; timestamp: number; }> = new Map();

	constructor (private ttlMs: number = 1000 * 60 * 60) {
		setInterval(() => this.cleanup(), Math.floor(ttlMs / 3));
	}

	public set(key: K, value: V): void {
		this.entries.set(key, { value, timestamp: Date.now() });
	}

	public get(key: K): V | undefined {
		const entry = this.entries.get(key);
		if (!entry) return undefined;

		if (Date.now() - entry.timestamp > this.ttlMs) {
			this.entries.delete(key);
			return undefined;
		}

		return entry.value;
	}

	public has(key: K): boolean {
		const entry = this.entries.get(key);
		if (!entry) return false;

		if (Date.now() - entry.timestamp > this.ttlMs) {
			this.entries.delete(key);
			return false;
		}

		return true;
	}

	public delete(key: K): boolean {
		return this.entries.delete(key);
	}

	public size(): number {
		this.cleanup();
		return this.entries.size;
	}

	private cleanup(): void {
		const now = Date.now();
		for (const [key, { timestamp }] of this.entries) {
			if (now - timestamp > this.ttlMs) {
				this.entries.delete(key);
			}
		}
	}
}
