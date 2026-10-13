import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildSubscriptionRequest,
  InvalidWebhookError,
  planKeyFromName,
  processPoseidonWebhook,
  webhookTokenDigest,
  type BillingPlan,
  type BillingSubscription,
  type BillingWebhookRepository,
  type PoseidonVerifier,
  type VerifiedGatewaySubscription,
  type VerifiedGatewayTransaction,
} from '../src/billing-core';

const basicPlan: BillingPlan = {
  id: 'plan-basic-id',
  name: 'Básico',
  price: 10.99,
  duration_days: 30,
  monthly_credits: 30,
  active: true,
};

const proPlan: BillingPlan = {
  id: 'plan-pro-id',
  name: 'PRO',
  price: 15.99,
  duration_days: 30,
  monthly_credits: 60,
  active: true,
};

class FakeRepository implements BillingWebhookRepository {
  credits = 0;
  appliedTransactions = new Set<string>();
  appliedCycles = new Set<string>();
  attemptStatuses = new Map<string, string>();
  subscriptionStatuses = new Map<string, string>();
  webhookTokenHashes = new Map<string, string>();
  subscription: BillingSubscription;

  constructor(plan = basicPlan) {
    this.subscription = {
      id: 'local-subscription-id',
      user_id: 'user-id',
      plan_id: plan.id,
      status: 'pending',
      gateway_identifier: 'gateway-identifier',
      gateway_subscription_id: 'poseidon-subscription-id',
      plan,
    };
    this.webhookTokenHashes.set('transaction-1', webhookTokenDigest('provider-event-token'));
  }

  async findSubscriptionByGatewayId(id: string) {
    return id === this.subscription.gateway_subscription_id ? this.subscription : null;
  }

  async findSubscriptionByIdentifier(identifier: string) {
    return identifier === this.subscription.gateway_identifier ? this.subscription : null;
  }

  async attachGatewaySubscriptionId(_subscriptionId: string, gatewayId: string) {
    this.subscription.gateway_subscription_id = gatewayId;
  }

  async validateInitialWebhookToken(transactionId: string, token: string) {
    const expected = this.webhookTokenHashes.get(transactionId);
    if (!expected) return 'not-found';
    return expected === webhookTokenDigest(token) ? 'match' : 'mismatch';
  }

  async applyConfirmedCycle(input: {
    subscriptionId: string;
    transactionId: string;
    cycleNumber: number | null;
  }) {
    const cycleKey = `${input.subscriptionId}:${input.cycleNumber}`;
    if (this.appliedTransactions.has(input.transactionId) || this.appliedCycles.has(cycleKey)) return false;
    this.appliedTransactions.add(input.transactionId);
    this.appliedCycles.add(cycleKey);
    this.credits += this.subscription.plan.monthly_credits;
    this.subscription.status = 'active';
    return true;
  }

  async markAttemptPaid(transactionId: string, _subscriptionId: string) {
    this.attemptStatuses.set(transactionId, 'paid');
  }

  async markAttemptFailed(transactionId: string, _subscriptionId?: string) {
    this.attemptStatuses.set(transactionId, 'failed');
  }

  async updateSubscriptionStatus(subscriptionId: string, status: 'canceled' | 'expired' | 'payment_failed') {
    if (subscriptionId === this.subscription.id) {
      this.subscriptionStatuses.set(subscriptionId, status);
    }
  }
}

class FakeVerifier implements PoseidonVerifier {
  transaction: VerifiedGatewayTransaction = {
    id: 'transaction-1',
    clientIdentifier: 'gateway-identifier',
    status: 'COMPLETED',
    amount: basicPlan.price,
    paymentMethod: 'PIX',
    purchaseType: 'RECURRING',
    payedAt: '2026-10-10T12:00:00.000Z',
  };
  subscriptions: VerifiedGatewaySubscription[] = [{
    id: 'poseidon-subscription-id',
    identifier: 'gateway-identifier',
    status: 'ACTIVE',
    cycle: 1,
  }];

  async getTransaction(id: string) {
    return { ...this.transaction, id };
  }

  async getSubscriptions() {
    return this.subscriptions;
  }
}

function paidWebhook(transactionId = 'transaction-1', cycle = 1) {
  return {
    event: 'SUBSCRIPTION_RENEWED',
    version: 1,
    occurredAt: '2026-10-10T12:00:00.000Z',
    token: 'provider-event-token',
    subscription: {
      id: 'poseidon-subscription-id',
      identifier: 'gateway-identifier',
      status: 'ACTIVE',
      cycle,
    },
    transaction: {
      id: transactionId,
      identifier: 'gateway-identifier',
      status: 'COMPLETED',
      amount: basicPlan.price,
    },
  };
}

test('builds the recurring charge from the server plan record', () => {
  const request = buildSubscriptionRequest(
    basicPlan,
    'attempt-unique-identifier',
    { name: 'Pessoa Teste', email: 'teste@example.com', phone: '11999999999' },
    'https://api.example.com/api/webhooks/poseidon/test-secret',
    'local-subscription-id',
  );

  assert.equal(request.amount, 10.99);
  assert.equal(request.product.id, 'plan-basic-id');
  assert.equal(request.subscription.periodicityType, 'MONTHS');
  assert.equal(request.subscription.periodicity, 1);
  assert.equal(request.identifier, 'attempt-unique-identifier');
  assert.equal(planKeyFromName(basicPlan.name), 'basic');
  assert.equal(planKeyFromName(proPlan.name), 'pro');
});

test('rejects a webhook without the documented authenticity token', async () => {
  await assert.rejects(
    processPoseidonWebhook(
      { ...paidWebhook(), token: '' },
      new FakeRepository(),
      new FakeVerifier(),
    ),
    InvalidWebhookError,
  );
});

test('rejects an initial payment event with the wrong provider webhook token', async () => {
  const event = paidWebhook();
  event.token = 'different-provider-token';

  await assert.rejects(
    processPoseidonWebhook(event, new FakeRepository(), new FakeVerifier()),
    InvalidWebhookError,
  );
});

test('does not grant credits twice for a duplicate confirmed webhook', async () => {
  const repository = new FakeRepository();
  const verifier = new FakeVerifier();
  const first = await processPoseidonWebhook(paidWebhook(), repository, verifier);
  const duplicate = await processPoseidonWebhook(paidWebhook(), repository, verifier);
  const duplicateCycle = await processPoseidonWebhook(
    paidWebhook('different-transaction-same-cycle', 1),
    repository,
    verifier,
  );

  assert.deepEqual(first, { outcome: 'paid', duplicate: false });
  assert.deepEqual(duplicate, { outcome: 'paid', duplicate: true });
  assert.deepEqual(duplicateCycle, { outcome: 'paid', duplicate: true });
  assert.equal(repository.credits, basicPlan.monthly_credits);
});

test('leaves a pending payment without credits', async () => {
  const repository = new FakeRepository();
  const verifier = new FakeVerifier();
  verifier.transaction.status = 'PENDING';

  const result = await processPoseidonWebhook(paidWebhook(), repository, verifier);

  assert.deepEqual(result, { outcome: 'pending' });
  assert.equal(repository.credits, 0);
  assert.equal(repository.appliedTransactions.size, 0);
});

test('grants credits only after the authenticated transaction is completed', async () => {
  const repository = new FakeRepository();
  const verifier = new FakeVerifier();

  const result = await processPoseidonWebhook(paidWebhook(), repository, verifier);

  assert.deepEqual(result, { outcome: 'paid', duplicate: false });
  assert.equal(repository.credits, 30);
  assert.equal(repository.subscription.status, 'active');
  assert.equal(repository.attemptStatuses.get('transaction-1'), 'paid');
});

test('grants the plan credits once for each confirmed renewal cycle', async () => {
  const repository = new FakeRepository(proPlan);
  const verifier = new FakeVerifier();
  verifier.transaction.amount = proPlan.price;
  verifier.transaction.id = 'transaction-cycle-1';

  await processPoseidonWebhook(paidWebhook('transaction-cycle-1', 1), repository, verifier);
  verifier.transaction.id = 'transaction-cycle-2';
  verifier.transaction.payedAt = '2026-11-09T12:00:00.000Z';
  await processPoseidonWebhook(paidWebhook('transaction-cycle-2', 2), repository, verifier);

  assert.equal(repository.credits, 120);
  assert.equal(repository.appliedTransactions.size, 2);
});

test('does not grant a failed payment', async () => {
  const repository = new FakeRepository();
  const verifier = new FakeVerifier();
  verifier.transaction.status = 'FAILED';

  const result = await processPoseidonWebhook(paidWebhook(), repository, verifier);

  assert.deepEqual(result, { outcome: 'failed' });
  assert.equal(repository.credits, 0);
  assert.equal(repository.attemptStatuses.get('transaction-1'), 'failed');
});

test('rejects a completed transaction with an amount different from the database plan', async () => {
  const repository = new FakeRepository();
  const verifier = new FakeVerifier();
  verifier.transaction.amount = proPlan.price;

  await assert.rejects(
    processPoseidonWebhook(paidWebhook(), repository, verifier),
    InvalidWebhookError,
  );
  assert.equal(repository.credits, 0);
});

test('cancels only after the authenticated subscription query confirms cancellation', async () => {
  const repository = new FakeRepository();
  const verifier = new FakeVerifier();
  verifier.subscriptions[0].status = 'CANCELED';
  const event = {
    event: 'SUBSCRIPTION_CANCELED',
    token: 'provider-event-token',
    subscription: { id: 'poseidon-subscription-id', identifier: 'gateway-identifier', status: 'CANCELED' },
  };

  const result = await processPoseidonWebhook(event, repository, verifier);

  assert.deepEqual(result, { outcome: 'canceled' });
  assert.equal(repository.subscriptionStatuses.get(repository.subscription.id), 'canceled');
  assert.equal(repository.credits, 0);
});

test('expires only after the authenticated subscription query confirms inactivity', async () => {
  const repository = new FakeRepository();
  const verifier = new FakeVerifier();
  verifier.subscriptions[0].status = 'INACTIVE';
  const event = {
    event: 'SUBSCRIPTION_EXPIRED',
    token: 'provider-event-token',
    subscription: { id: 'poseidon-subscription-id', identifier: 'gateway-identifier', status: 'INACTIVE' },
  };

  const result = await processPoseidonWebhook(event, repository, verifier);

  assert.deepEqual(result, { outcome: 'expired' });
  assert.equal(repository.subscriptionStatuses.get(repository.subscription.id), 'expired');
  assert.equal(repository.credits, 0);
});
