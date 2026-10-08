export type SubscriptionEvent =
  | 'subscription.created'
  | 'subscription.charged'
  | 'subscription.payment_failed'
  | 'subscription.paused'
  | 'subscription.resumed'
  | 'subscription.canceled';

/**
 * CHANGE (optional but recommended): call the repo's webhook/notification
 * dispatcher here. Look in src/domains/webhooks/ for the function that
 * queues an event (search for "tip.created") and call it the same way.
 */
export async function emitSubscriptionEvent(
  event: SubscriptionEvent,
  payload: Record<string, unknown>,
): Promise<void> {
  console.info(`[subscriptions] ${event}`, payload);
}