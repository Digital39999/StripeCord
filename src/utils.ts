export function stringifyError<T>(error: T): unknown {
	if (typeof error === 'string') return error;
	else if (error instanceof Error) return { name: error.name, message: error.message, stack: error.stack };

	try {
		return JSON.stringify(error);
	} catch {
		return error;
	}
}

export function getYearlyMultiplier(times?: number): number {
	return (times || 0) < 1 ? 10 : times || 10;
}
