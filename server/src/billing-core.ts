import crypto from 'node:crypto';
import { z } from 'zod';

export type PlanKey = 'basic' | 'starter' | 'pro' | 'premium';

export type BillingPlan = {
  id: string;
  name: string;
  price: number;
  duration_days: number;
  monthly_credits: number;
  active: boolean;
};

export type BillingSubscription = {
  id: string;
  user_id: string;
  plan_id: string;
  status: string;
  gateway_identifier: string | null;
  gateway_subscription_id: string | null;
  plan: BillingPlan;
};

export type BillingClient = {
  name: string;
  email: string;
  phone: string;
  document?: string;
};

export function webhookTokenDigest(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export function buildSubscriptionRequest(
  plan: BillingPlan,
  identifier: string,
  client: BillingClient,
  callbackUrl: string,
  localSubscriptionId: string,
) {
  return {
    identifier,
    amount: plan.price,
    product: {
      id: plan.id,
      name: plan.name,
      price: plan.price,
    },
    subscription: {
      periodicityType: plan.duration_days === 30 ? 'MONTHS' : 'DAYS',
      periodicity: plan.duration_days === 30 ? 1 : plan.duration_days,
      firstChargeIn: 0,
    },
    client,
    callbackUrl,
    metadata: {
      provider: 'WebForge AI',
      planId: plan.id,
      localSubscriptionId,
    },
  };
}

const transactionSchema = z.object({
  id: z.string().min(1),
  identifier: z.string().optional().nullable(),
  clientIdentifier: z.string().optional().nullable(),
  status: z.string().optional(),
  amount: z.number().finite().optional(),
  paymentMethod: z.string().optional(),
  purchaseType: z.string().optional(),
  payedAt: z.string().optional().nullable(),
}).passthrough();

const subscriptionSchema = z.object({
  id: z.string().min(1),
  identifier: z.string().optional().nullable(),
  status: z.string().optional(),
  cycle: z.number().int().positive().optional().nullable(),
  nextChargeAt: z.string().optional().nullable(),
  expiresAt: z.string().optional().nullable(),
}).passthrough();

const webhookSchema = z.object({
  event: z.string().min(1),
  token: z.string().min(1),
  version: z.number().optional(),
  occurredAt: z.string().optional(),
  transaction: transactionSchema.nullable().optional(),
  subscription: subscriptionSchema.nullable().optional(),
}).passthrough();

export type PoseidonWebhook = z.infer<typeof webhookSchema>;

export type VerifiedGatewayTransaction = {
  id: string;
  identifier?: string | null;
  clientIdentifier?: string | null;
  status: string;
  amount: number;
  paymentMethod?: string;
  purchaseType?: string;
  payedAt?: string | null;
};

export type VerifiedGatewaySubscription = {
  id: string;
  identifier?: string | null;
  status?: string;
  cycle?: number | null;
  nextChargeAt?: string | null;
  expiresAt?: string | null;
};

export interface BillingWebhookRepository {
  findSubscriptionByGatewayId(id: string): Promise<BillingSubscription | null>;
  findSubscriptionByIdentifier(identifier: string): Promise<BillingSubscription | null>;
  attachGatewaySubscriptionId(subscriptionId: string, gatewayId: string): Promise<void>;
  validateInitialWebhookToken(
    transactionId: string,
    token: string,
  ): Promise<'not-found' | 'match' | 'mismatch'>;
  applyConfirmedCycle(input: {
    subscriptionId: string;
    transactionId: string;
    cycleNumber: number | null;
    amount: number;
    confirmedAt: string;
  }): Promise<boolean>;
  markAttemptPaid(transactionId: string, subscriptionId: string): Promise<void>;
  markAttemptFailed(transactionId: string, subscriptionId?: string): Promise<void>;
  updateSubscriptionStatus(
    subscriptionId: string,
    status: 'canceled' | 'expired' | 'payment_failed',
  ): Promise<void>;
}

export interface PoseidonVerifier {
  getTransaction(id: string): Promise<VerifiedGatewayTransaction>;
  getSubscriptions(filters: {
    transactionId?: string;
    subscriptionId?: string;
  }): Promise<VerifiedGatewaySubscription[]>;
}

export type WebhookResult =
  | { outcome: 'ignored' | 'pending' | 'failed' | 'canceled' | 'expired' }
  | { outcome: 'paid'; duplicate: boolean };

export class InvalidWebhookError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidWebhookError';
  }
}

function sameAmount(a: number, b: number): boolean {
  return Math.round(a * 100) === Math.round(b * 100);
}

function eventDate(payload: PoseidonWebhook, transaction: VerifiedGatewayTransaction): string {
  const date = transaction.payedAt || payload.occurredAt;
  if (!date || !Number.isFinite(Date.parse(date))) {
    throw new InvalidWebhookError('Paid transaction has no valid payment timestamp.');
  }
  return new Date(date).toISOString();
}

export async function processPoseidonWebhook(
  body: unknown,
  repository: BillingWebhookRepository,
  verifier: PoseidonVerifier,
): Promise<WebhookResult> {
  const parsed = webhookSchema.safeParse(body);
  if (!parsed.success) {
    throw new InvalidWebhookError('Webhook payload is missing required documented fields.');
  }
  const payload = parsed.data;

  if (payload.event === 'SUBSCRIPTION_CANCELED' || payload.event === 'SUBSCRIPTION_EXPIRED') {
    const gatewayId = payload.subscription?.id;
    if (!gatewayId) throw new InvalidWebhookError('Subscription event has no subscription ID.');

    const local = await repository.findSubscriptionByGatewayId(gatewayId)
      || (payload.subscription?.identifier
        ? await repository.findSubscriptionByIdentifier(payload.subscription.identifier)
        : null);
    if (!local) return { outcome: 'ignored' };

    const [remote] = await verifier.getSubscriptions({ subscriptionId: gatewayId });
    if (!remote || remote.id !== gatewayId) {
      throw new InvalidWebhookError('PoseidonPay did not confirm the subscription ID.');
    }
    await repository.attachGatewaySubscriptionId(local.id, gatewayId);

    if (payload.event === 'SUBSCRIPTION_CANCELED' && remote.status === 'CANCELED') {
      await repository.updateSubscriptionStatus(local.id, 'canceled');
      return { outcome: 'canceled' };
    }
    if (payload.event === 'SUBSCRIPTION_EXPIRED' && remote.status === 'INACTIVE') {
      await repository.updateSubscriptionStatus(local.id, 'expired');
      return { outcome: 'expired' };
    }
    return { outcome: 'ignored' };
  }

  if (payload.event === 'SUBSCRIPTION_RENEWAL_PENDING') {
    return { outcome: 'pending' };
  }

  if (!['TRANSACTION_PAID', 'SUBSCRIPTION_STARTED', 'SUBSCRIPTION_RENEWED'].includes(payload.event)) {
    if (payload.event === 'TRANSACTION_CANCELED') {
      const transactionId = payload.transaction?.id;
      if (!transactionId) throw new InvalidWebhookError('Transaction event has no transaction ID.');
      const tokenResult = await repository.validateInitialWebhookToken(transactionId, payload.token);
      if (tokenResult === 'mismatch') {
        throw new InvalidWebhookError('Webhook token does not match the initial payment token.');
      }
      const transaction = await verifier.getTransaction(transactionId);
      if (transaction.id !== transactionId) {
        throw new InvalidWebhookError('PoseidonPay did not confirm the transaction ID.');
      }
      if (transaction.status === 'FAILED' || transaction.status === 'CANCELED') {
        const identifier = transaction.clientIdentifier || payload.transaction?.identifier;
        const local = identifier
          ? await repository.findSubscriptionByIdentifier(identifier)
          : null;
        await repository.markAttemptFailed(transactionId, local?.id);
        if (local?.status === 'pending') {
          await repository.updateSubscriptionStatus(local.id, 'payment_failed');
        }
        return { outcome: 'failed' };
      }
    }
    return { outcome: 'ignored' };
  }

  const transactionId = payload.transaction?.id;
  const gatewaySubscriptionId = payload.subscription?.id;
  if (!transactionId || !gatewaySubscriptionId) {
    return { outcome: 'pending' };
  }

  const local = await repository.findSubscriptionByGatewayId(gatewaySubscriptionId)
    || (payload.subscription?.identifier
      ? await repository.findSubscriptionByIdentifier(payload.subscription.identifier)
      : null);
  if (!local) return { outcome: 'ignored' };

  const tokenResult = await repository.validateInitialWebhookToken(transactionId, payload.token);
  if (tokenResult === 'mismatch') {
    throw new InvalidWebhookError('Webhook token does not match the initial payment token.');
  }

  const [transaction, relatedSubscription] = await Promise.all([
    verifier.getTransaction(transactionId),
    verifier.getSubscriptions({ transactionId }),
  ]);

  if (transaction.id !== transactionId || !relatedSubscription.some(
    (subscription) => subscription.id === gatewaySubscriptionId,
  )) {
    throw new InvalidWebhookError('Authenticated PoseidonPay records do not match the webhook.');
  }
  await repository.attachGatewaySubscriptionId(local.id, gatewaySubscriptionId);

  if (transaction.status === 'PENDING') return { outcome: 'pending' };
  if (transaction.status === 'FAILED' || transaction.status === 'CANCELED') {
    await repository.markAttemptFailed(transactionId, local.id);
    if (local.status === 'pending') {
      await repository.updateSubscriptionStatus(local.id, 'payment_failed');
    }
    return { outcome: 'failed' };
  }

  if (
    transaction.status !== 'COMPLETED'
    || transaction.purchaseType !== 'RECURRING'
    || transaction.paymentMethod !== 'PIX'
    || !sameAmount(transaction.amount, local.plan.price)
  ) {
    throw new InvalidWebhookError('Authenticated transaction is not a paid Pix subscription for this plan.');
  }

  const identifiers = [
    transaction.clientIdentifier,
    relatedSubscription.find((subscription) => subscription.id === gatewaySubscriptionId)?.identifier,
  ].filter((value): value is string => Boolean(value));
  if (local.gateway_identifier && identifiers.length && !identifiers.includes(local.gateway_identifier)) {
    throw new InvalidWebhookError('Authenticated transaction does not match the local payment identifier.');
  }

  const applied = await repository.applyConfirmedCycle({
    subscriptionId: local.id,
    transactionId,
    cycleNumber: payload.subscription?.cycle ?? null,
    amount: transaction.amount,
    confirmedAt: eventDate(payload, transaction),
  });
  await repository.markAttemptPaid(transactionId, local.id);
  return { outcome: 'paid', duplicate: !applied };
}

export function planKeyFromName(name: string): PlanKey | null {
  const normalized = name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLowerCase();
  if (normalized === 'basico' || normalized === 'basic') return 'basic';
  if (normalized === 'starter') return 'starter';
  if (normalized === 'pro' || normalized === 'pros') return 'pro';
  if (normalized === 'premium') return 'premium';
  return null;
}
